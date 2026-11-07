import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  alerts,
  applications,
  auditLog,
  combinationAlerts,
  combinationAutomationRuns,
  combinationAutomations,
  combinations,
  type CombinationAutomation,
} from "@/db/schema";
import type { CombinationState } from "@/domain/combination";
import { increment } from "@/lib/metrics";
import type { Db, Tx } from "./db-types";
import { NotFoundError } from "./errors";
import { execute, outboundShape, withSlot, webhookModeRule, type Outcome, type RemediationDeps, type RequestSpec } from "./remediation";

type TriggerState = "alert" | "ok";

// Mesmo cadastro da remediação do alerta; os gatilhos são só a entrada em "alert" e a volta a "ok".
const automationShape = { ...outboundShape, triggerStates: z.array(z.enum(["alert", "ok"])).min(1).default(["alert"]) };

export const combinationAutomationSchema = z.object(automationShape).refine(webhookModeRule.check, { message: webhookModeRule.message });
export type AutomationInput = z.infer<typeof combinationAutomationSchema>;

export type AutomationPatch = Partial<AutomationInput>;

// Cada campo é opcional e sem padrão (um padrão sobrescreveria o valor atual); o resultado mesclado com o atual
// é revalidado por completo em updateAutomation.
const withoutDefault = (field: z.ZodType): z.ZodType => (field instanceof z.ZodDefault ? (field.removeDefault() as z.ZodType) : field).optional();
export const updateAutomationSchema = (
  z.object(Object.fromEntries(Object.entries(automationShape).map(([key, field]) => [key, withoutDefault(field)]))) as unknown as z.ZodType<AutomationPatch>
).refine((v) => Object.keys(v).length > 0, "empty update");

export type PendingAutomation = {
  automation: CombinationAutomation;
  combinationId: number;
  state: TriggerState;
  previousState: CombinationState;
};

const toRow = (combinationId: number, input: AutomationInput) => ({
  combinationId,
  name: input.name,
  mode: input.mode,
  url: input.url,
  method: input.method,
  headers: input.headers,
  bodyTemplate: input.bodyTemplate ?? null,
  triggerStates: input.triggerStates,
  timeoutMs: input.timeoutMs,
  enabled: input.enabled,
});

/** Grava a automação e a auditoria dentro da transação do chamador. */
export async function insertAutomation(tx: Tx, combinationId: number, input: AutomationInput, actor: string) {
  const [row] = await tx.insert(combinationAutomations).values(toRow(combinationId, input)).returning();
  await tx.insert(auditLog).values({
    kind: "combination_automation_created",
    actor,
    combinationId,
    details: { automationId: row.id, name: input.name, mode: input.mode, url: input.url, triggerStates: input.triggerStates },
  });
  return row;
}

export async function addAutomation(db: Db, combinationId: number, input: AutomationInput, actor: string) {
  return db.transaction(async (tx) => {
    const [combination] = await tx.select({ id: combinations.id }).from(combinations).where(eq(combinations.id, combinationId));
    if (!combination) throw new NotFoundError("combination not found");
    return insertAutomation(tx, combinationId, input, actor);
  });
}

/** Altera campos da automação; o resultado é revalidado como um todo e a auditoria guarda antes/depois. */
export async function updateAutomation(
  db: Db,
  combinationId: number,
  automationId: number,
  patch: AutomationPatch,
  actor: string,
) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(combinationAutomations)
      .where(and(eq(combinationAutomations.id, automationId), eq(combinationAutomations.combinationId, combinationId)))
      .for("update");
    if (!current) throw new NotFoundError("automation not found");
    const merged = combinationAutomationSchema.parse({ ...current, ...patch });
    const set: Partial<typeof combinationAutomations.$inferInsert> = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(patch) as (keyof AutomationInput)[]) {
      const after = key === "bodyTemplate" ? (merged.bodyTemplate ?? null) : merged[key];
      if (JSON.stringify(current[key]) === JSON.stringify(after)) continue;
      (set as Record<string, unknown>)[key] = after;
      // Cabeçalhos só pelos nomes: o valor é uma referência env:NOME ou texto livre que não precisa ir à auditoria.
      changes[key] = key === "headers" ? { from: Object.keys(current.headers), to: Object.keys(merged.headers) } : { from: current[key], to: after };
    }
    if (Object.keys(set).length === 0) return current;
    const [row] = await tx
      .update(combinationAutomations)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(combinationAutomations.id, automationId))
      .returning();
    await tx.insert(auditLog).values({
      kind: "combination_automation_updated",
      actor,
      combinationId,
      details: { automationId, changes },
    });
    return row;
  });
}

/** Automações ativas da combinação que reagem ao estado. */
export async function findTriggeredAutomations(db: Pick<Db, "select">, combinationId: number, state: TriggerState) {
  return db
    .select()
    .from(combinationAutomations)
    .where(
      and(
        eq(combinationAutomations.combinationId, combinationId),
        eq(combinationAutomations.enabled, true),
        sql`${state}::combination_state = any(${combinationAutomations.triggerStates})`,
      ),
    );
}

/** Executa as automações depois do commit; cada execução vai para a tabela de execuções e para a auditoria. */
export async function runAutomations(db: Db, pending: PendingAutomation[], deps: RemediationDeps) {
  await Promise.all(pending.map((item) => runOne(db, item, deps)));
}

async function requestSpec(db: Db, item: PendingAutomation): Promise<RequestSpec | null> {
  const [combination] = await db.select().from(combinations).where(eq(combinations.id, item.combinationId));
  if (!combination) return null;
  const components = await db
    .select({
      id: alerts.id,
      name: alerts.name,
      application: applications.name,
      state: alerts.state,
      since: alerts.stateChangedAt,
      priority: alerts.priority,
    })
    .from(combinationAlerts)
    .innerJoin(alerts, eq(alerts.id, combinationAlerts.alertId))
    .innerJoin(applications, eq(applications.id, alerts.applicationId))
    .where(eq(combinationAlerts.combinationId, item.combinationId))
    .orderBy(alerts.id);
  return {
    vars: {
      "combination.id": combination.id,
      "combination.name": combination.name,
      "combination.state": item.state,
      "combination.previous_state": item.previousState,
      "combination.rule": combination.rule,
      "combination.components": components.map((c) => c.name).join(","),
    },
    payload: {
      source: "global-alerts",
      combination: {
        id: combination.id,
        name: combination.name,
        state: item.state,
        previous_state: item.previousState,
        rule: combination.rule,
        min_count: combination.minCount,
        duration_seconds: combination.durationSeconds,
        since: (combination.satisfiedSince ?? combination.stateChangedAt).toISOString(),
        components: components.map((c) => ({ ...c, since: c.since.toISOString() })),
      },
      firedAt: new Date().toISOString(),
    },
  };
}

async function runOne(db: Db, item: PendingAutomation, deps: RemediationDeps) {
  const spec = await requestSpec(db, item);
  if (!spec) return;
  const result = await withSlot(() => execute(item.automation, spec, deps));
  const outcome: Outcome =
    result === "queue-full" ? { status: "skipped", httpStatus: null, durationMs: null, error: "remediation queue full" } : result;
  increment("combination_automation_runs_total", { status: outcome.status });
  await db.transaction(async (tx) => {
    await tx.insert(combinationAutomationRuns).values({
      automationId: item.automation.id,
      combinationId: item.combinationId,
      triggerState: item.state,
      ...outcome,
    });
    await tx.insert(auditLog).values({
      kind: "combination_automation_run",
      actor: "system:combination",
      combinationId: item.combinationId,
      details: { automationId: item.automation.id, name: item.automation.name, state: item.state, ...outcome },
    });
  });
}
