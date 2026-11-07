import { and, eq, exists, inArray, isNull } from "drizzle-orm";
import { alerts, auditLog, combinationAlerts, combinationEvaluatorHeartbeat, combinations } from "@/db/schema";
import { nextState, ruleMet } from "@/domain/combination";
import { increment } from "@/lib/metrics";
import { findTriggeredAutomations, type PendingAutomation } from "./combination-automations";
import type { Db, Tx } from "./db-types";

export type EvaluateResult = { evaluated: number; changed: number; pending: PendingAutomation[] };
type EvaluateOptions = { alertId?: number; combinationIds?: number[]; now?: Date };

/**
 * Reavalia combinações não arquivadas (todas, as que contêm `alertId` ou as de `combinationIds`) contra o estado
 * atual dos alertas. Cada combinação é avaliada numa transação que trava a linha, então avaliações concorrentes
 * geram uma só transição. Devolve as automações a executar DEPOIS do commit.
 */
export async function evaluateCombinations(db: Db, options: EvaluateOptions = {}): Promise<EvaluateResult> {
  const now = options.now ?? new Date();
  const conditions = [isNull(combinations.archivedAt)];
  if (options.combinationIds) conditions.push(inArray(combinations.id, options.combinationIds));
  if (options.alertId !== undefined) {
    conditions.push(
      exists(
        db
          .select({ one: combinationAlerts.alertId })
          .from(combinationAlerts)
          .where(and(eq(combinationAlerts.combinationId, combinations.id), eq(combinationAlerts.alertId, options.alertId))),
      ),
    );
  }
  const rows = await db.select({ id: combinations.id }).from(combinations).where(and(...conditions)).orderBy(combinations.id);

  const result: EvaluateResult = { evaluated: 0, changed: 0, pending: [] };
  for (const { id } of rows) {
    const outcome = await db.transaction((tx) => evaluateOne(tx, id, now));
    if (!outcome) continue;
    result.evaluated += 1;
    if (outcome.to) {
      result.changed += 1;
      increment("combination_transitions_total", { to: outcome.to });
    }
    result.pending.push(...outcome.pending);
  }
  return result;
}

async function evaluateOne(tx: Tx, id: number, now: Date): Promise<{ to: string | null; pending: PendingAutomation[] } | null> {
  const [combination] = await tx.select().from(combinations).where(eq(combinations.id, id)).for("update");
  if (!combination || combination.archivedAt) return null;

  const components = await tx
    .select({ id: alerts.id, state: alerts.state, archivedAt: alerts.archivedAt, mutedUntil: alerts.mutedUntil })
    .from(combinationAlerts)
    .innerJoin(alerts, eq(alerts.id, combinationAlerts.alertId))
    .where(eq(combinationAlerts.combinationId, id))
    .orderBy(alerts.id);
  // Só "alert" conta; silenciado e arquivado não (silêncio vence sozinho, por isso o avaliador periódico).
  const alerting = components.filter((c) => c.state === "alert" && !c.archivedAt && !(c.mutedUntil && c.mutedUntil > now));
  const met = ruleMet({ rule: combination.rule, minCount: combination.minCount }, alerting.length, components.length);
  const step = nextState({ state: combination.state, satisfiedSince: combination.satisfiedSince, met, durationSeconds: combination.durationSeconds, now });

  const sinceChanged = step.satisfiedSince?.getTime() !== combination.satisfiedSince?.getTime();
  if (!step.changed && !sinceChanged) return { to: null, pending: [] };
  await tx
    .update(combinations)
    .set({
      state: step.state,
      satisfiedSince: step.satisfiedSince,
      stateChangedAt: step.changed ? now : combination.stateChangedAt,
      updatedAt: now,
    })
    .where(eq(combinations.id, id));
  if (!step.changed) return { to: null, pending: [] };

  await tx.insert(auditLog).values({
    kind: "combination_state_changed",
    actor: "system:combination",
    combinationId: id,
    details: {
      from: combination.state,
      to: step.state,
      alerting: alerting.map((c) => c.id),
      rule: combination.rule,
      minCount: combination.minCount,
      durationSeconds: combination.durationSeconds,
    },
  });

  // pending nunca dispara; voltar de pending para ok também não (nunca houve alerta).
  const trigger = step.state === "alert" ? "alert" : combination.state === "alert" && step.state === "ok" ? "ok" : null;
  const automations = trigger ? await findTriggeredAutomations(tx, id, trigger) : [];
  return {
    to: step.state,
    pending: trigger ? automations.map((automation) => ({ automation, combinationId: id, state: trigger, previousState: combination.state })) : [],
  };
}

/** Marca que o avaliador periódico terminou um ciclo (linha única; vale entre instâncias e reinícios). */
export async function recordEvaluatorRun(db: Db, now: Date = new Date()) {
  await db
    .insert(combinationEvaluatorHeartbeat)
    .values({ id: 1, lastRunAt: now })
    .onConflictDoUpdate({ target: combinationEvaluatorHeartbeat.id, set: { lastRunAt: now } });
}
