import { desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  alerts,
  applications,
  auditLog,
  combinationAlerts,
  combinationAutomationRuns,
  combinationAutomations,
  combinations,
  type Combination,
} from "@/db/schema";
import type { AlertState } from "@/domain/alert-machine";
import type { Db } from "./db-types";

const LIST_LIMIT = 500;

export type ComponentView = {
  id: number;
  name: string;
  application: string;
  state: AlertState;
  priority: number | null;
  stateChangedAt: Date;
  muted: boolean;
  archived: boolean;
  /** Conta para a regra: em alert, não silenciado e não arquivado. */
  alerting: boolean;
};
export type CombinationView = Combination & { components: ComponentView[]; alertingCount: number; hasArchivedComponent: boolean };

async function withComponents(db: Db, rows: Combination[], now: Date): Promise<CombinationView[]> {
  if (rows.length === 0) return [];
  const components = await db
    .select({
      combinationId: combinationAlerts.combinationId,
      id: alerts.id,
      name: alerts.name,
      application: applications.name,
      state: alerts.state,
      priority: alerts.priority,
      stateChangedAt: alerts.stateChangedAt,
      mutedUntil: alerts.mutedUntil,
      archivedAt: alerts.archivedAt,
    })
    .from(combinationAlerts)
    .innerJoin(alerts, eq(alerts.id, combinationAlerts.alertId))
    .innerJoin(applications, eq(applications.id, alerts.applicationId))
    .where(inArray(combinationAlerts.combinationId, rows.map((r) => r.id)))
    .orderBy(alerts.id);
  const byCombination = new Map<number, ComponentView[]>();
  for (const c of components) {
    const muted = c.mutedUntil !== null && c.mutedUntil > now;
    const archived = c.archivedAt !== null;
    const view: ComponentView = {
      id: c.id,
      name: c.name,
      application: c.application,
      state: c.state,
      priority: c.priority,
      stateChangedAt: c.stateChangedAt,
      muted,
      archived,
      alerting: c.state === "alert" && !muted && !archived,
    };
    byCombination.set(c.combinationId, [...(byCombination.get(c.combinationId) ?? []), view]);
  }
  return rows.map((row) => {
    const list = byCombination.get(row.id) ?? [];
    return { ...row, components: list, alertingCount: list.filter((c) => c.alerting).length, hasArchivedComponent: list.some((c) => c.archived) };
  });
}

/** Para o mapa: alert primeiro, depois pending, depois ok; mais recentes antes dentro de cada estado. */
export async function listCombinations(db: Db, options: { includeArchived?: boolean; now?: Date } = {}) {
  const rows = await db
    .select()
    .from(combinations)
    .where(options.includeArchived ? undefined : isNull(combinations.archivedAt))
    .orderBy(sql`case ${combinations.state} when 'alert' then 0 when 'pending' then 1 else 2 end`, desc(combinations.stateChangedAt), combinations.id)
    .limit(LIST_LIMIT);
  return withComponents(db, rows, options.now ?? new Date());
}

export async function getCombination(db: Db, id: number, now: Date = new Date()) {
  const [row] = await db.select().from(combinations).where(eq(combinations.id, id));
  if (!row) return null;
  const [[view], automations, runs, audit] = await Promise.all([
    withComponents(db, [row], now),
    db.select().from(combinationAutomations).where(eq(combinationAutomations.combinationId, id)).orderBy(combinationAutomations.id),
    db
      .select()
      .from(combinationAutomationRuns)
      .where(eq(combinationAutomationRuns.combinationId, id))
      .orderBy(desc(combinationAutomationRuns.id))
      .limit(20),
    db.select().from(auditLog).where(eq(auditLog.combinationId, id)).orderBy(desc(auditLog.id)).limit(50),
  ]);
  return { ...view, automations, runs, audit };
}
