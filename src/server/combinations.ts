import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { alerts, auditLog, combinationAlerts, combinations, type Combination } from "@/db/schema";
import { COMBINATION_RULES, type CombinationRule } from "@/domain/combination";
import { combinationAutomationSchema, insertAutomation } from "./combination-automations";
import { evaluateCombinations } from "./combination-evaluator";
import type { Db, Tx } from "./db-types";
import { ConflictError, NotFoundError, ValidationError } from "./errors";

const fields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullish(),
  rule: z.enum(COMBINATION_RULES),
  minCount: z.number().int().min(1).max(20).nullish(),
  durationSeconds: z.number().int().min(0).max(86_400),
  alertIds: z.array(z.number().int().positive()).min(1).max(20),
};

/** Coerência entre regra, N e a lista de alertas; null = válido. */
function ruleProblem(v: { rule: CombinationRule; minCount?: number | null; alertIds: number[] }): string | null {
  if (new Set(v.alertIds).size !== v.alertIds.length) return "alertIds must not repeat";
  if (v.rule === "at_least") {
    if (v.minCount == null) return "minCount is required for the at_least rule";
    if (v.minCount > v.alertIds.length) return "minCount cannot exceed the number of alerts";
  } else if (v.minCount != null) return "minCount is only for the at_least rule";
  return null;
}

export const createCombinationSchema = z
  .object({
    ...fields,
    durationSeconds: fields.durationSeconds.default(0),
    automations: z.array(combinationAutomationSchema).max(10).default([]),
  })
  .superRefine((v, ctx) => {
    const problem = ruleProblem(v);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
export type CreateCombinationInput = z.infer<typeof createCombinationSchema>;

export const updateCombinationSchema = z
  .object(fields)
  .partial()
  .extend({ archived: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, "empty update");
export type UpdateCombinationInput = z.infer<typeof updateCombinationSchema>;

const sortedIds = (ids: number[]) => [...ids].sort((a, b) => a - b);

async function assertAlertsUsable(tx: Tx, alertIds: number[]) {
  const rows = await tx.select({ id: alerts.id }).from(alerts).where(and(inArray(alerts.id, alertIds), isNull(alerts.archivedAt)));
  const found = new Set(rows.map((r) => r.id));
  const missing = alertIds.filter((id) => !found.has(id));
  if (missing.length > 0) throw new ValidationError(`alerts not found or archived: ${missing.join(", ")}`);
}

const linkedIds = async (tx: Tx, combinationId: number) =>
  sortedIds((await tx.select({ id: combinationAlerts.alertId }).from(combinationAlerts).where(eq(combinationAlerts.combinationId, combinationId))).map((r) => r.id));

/** Avalia na hora (a regra pode já valer) e devolve a combinação atual com as automações a executar. */
async function settle(db: Db, id: number) {
  const { pending } = await evaluateCombinations(db, { combinationIds: [id] });
  const [combination] = await db.select().from(combinations).where(eq(combinations.id, id));
  return { combination, pending };
}

export async function createCombination(db: Db, input: CreateCombinationInput, actor: string) {
  const alertIds = sortedIds(input.alertIds);
  const id = await db.transaction(async (tx) => {
    await assertAlertsUsable(tx, alertIds);
    const [row] = await tx
      .insert(combinations)
      .values({
        name: input.name,
        description: input.description ?? null,
        rule: input.rule,
        minCount: input.minCount ?? null,
        durationSeconds: input.durationSeconds,
      })
      .onConflictDoNothing()
      .returning({ id: combinations.id });
    if (!row) throw new ConflictError("a combination with this name already exists");
    await tx.insert(combinationAlerts).values(alertIds.map((alertId) => ({ combinationId: row.id, alertId })));
    await tx.insert(auditLog).values({
      kind: "combination_created",
      actor,
      combinationId: row.id,
      details: {
        name: input.name,
        rule: input.rule,
        minCount: input.minCount ?? null,
        durationSeconds: input.durationSeconds,
        alertIds,
        automations: input.automations.length,
      },
    });
    for (const automation of input.automations) await insertAutomation(tx, row.id, automation, actor);
    return row.id;
  });
  return settle(db, id);
}

type Changes = Record<string, { from: unknown; to: unknown }>;

/** Altera campos, lista de alertas ou arquivamento; a auditoria guarda antes/depois e a regra é revalidada por inteiro. */
export async function updateCombination(db: Db, id: number, patch: UpdateCombinationInput, actor: string) {
  const touched = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(combinations).where(eq(combinations.id, id)).for("update");
    if (!current) throw new NotFoundError("combination not found");
    const currentIds = await linkedIds(tx, id);
    const { archived, alertIds, ...scalars } = patch;

    const problem = ruleProblem({
      rule: scalars.rule ?? current.rule,
      minCount: scalars.minCount !== undefined ? scalars.minCount : current.minCount,
      alertIds: alertIds ?? currentIds,
    });
    if (problem) throw new ValidationError(problem);
    // Só os alertas novos precisam estar ativos: uma combinação com componente arquivado continua editável.
    if (alertIds) {
      const added = alertIds.filter((alertId) => !currentIds.includes(alertId));
      if (added.length > 0) await assertAlertsUsable(tx, added);
    }
    if (scalars.name && scalars.name !== current.name) {
      const [clash] = await tx.select({ id: combinations.id }).from(combinations).where(and(eq(combinations.name, scalars.name), ne(combinations.id, id)));
      if (clash) throw new ConflictError("a combination with this name already exists");
    }

    const set: Partial<typeof combinations.$inferInsert> = {};
    const changes: Changes = {};
    for (const key of ["name", "description", "rule", "minCount", "durationSeconds"] as const) {
      if (scalars[key] === undefined) continue;
      const to = key === "description" || key === "minCount" ? (scalars[key] ?? null) : scalars[key];
      if (current[key] === to) continue;
      (set as Record<string, unknown>)[key] = to;
      changes[key] = { from: current[key], to };
    }
    const nextIds = alertIds ? sortedIds(alertIds) : currentIds;
    const idsChanged = JSON.stringify(nextIds) !== JSON.stringify(currentIds);
    if (idsChanged) changes.alertIds = { from: currentIds, to: nextIds };
    const archiveChanged = archived !== undefined && archived !== (current.archivedAt !== null);
    if (archiveChanged) set.archivedAt = archived ? new Date() : null;
    // Arquivar encerra o ciclo: sem isso, restaurar depois reavaliaria um incidente antigo e dispararia a automação "ok" à toa.
    const resetFrom = archiveChanged && archived && current.state !== "ok" ? current.state : null;
    if (resetFrom) Object.assign(set, { state: "ok", satisfiedSince: null, stateChangedAt: new Date() });
    if (Object.keys(set).length === 0 && !idsChanged) return false;

    await tx.update(combinations).set({ ...set, updatedAt: new Date() }).where(eq(combinations.id, id));
    if (idsChanged) {
      await tx.delete(combinationAlerts).where(eq(combinationAlerts.combinationId, id));
      await tx.insert(combinationAlerts).values(nextIds.map((alertId) => ({ combinationId: id, alertId })));
    }
    if (Object.keys(changes).length > 0) {
      await tx.insert(auditLog).values({ kind: "combination_updated", actor, combinationId: id, details: { changes } });
    }
    if (archiveChanged) {
      await tx.insert(auditLog).values({ kind: "combination_archived", actor, combinationId: id, details: { archived: Boolean(archived), ...(resetFrom ? { resetFrom } : {}) } });
    }
    return true;
  });
  if (touched) return settle(db, id);
  const [combination] = await db.select().from(combinations).where(eq(combinations.id, id));
  return { combination: combination as Combination, pending: [] };
}
