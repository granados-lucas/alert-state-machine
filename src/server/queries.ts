import { and, asc, count, desc, eq, ilike, inArray, isNull, lt, sql } from "drizzle-orm";
import { alerts, applications, auditLog, journeyApplications, journeys, remediationRuns, remediations } from "@/db/schema";
import type { AlertState } from "@/domain/alert-machine";
import { bySeverityDesc, emptyCounts, sumCounts, worstState, type StateCounts } from "@/domain/application-status";
import type { Db } from "./db-types";

export type MapApplication = { name: string; counts: StateCounts; total: number; status: AlertState | null };
export type MapJourney = {
  id: number;
  name: string;
  description: string | null;
  applications: MapApplication[];
  counts: StateCounts;
  total: number;
  status: AlertState | null;
};

/** Aplicações com contagens por estado e o pior estado entre seus alertas ativos. */
export async function getApplicationMap(db: Db) {
  const rows = await db
    .select({ name: applications.name, state: alerts.state, n: count(alerts.id) })
    .from(applications)
    .leftJoin(alerts, and(eq(alerts.applicationId, applications.id), isNull(alerts.archivedAt)))
    .groupBy(applications.name, alerts.state);
  const byName = new Map<string, MapApplication>();
  for (const row of rows) {
    const app = byName.get(row.name) ?? { name: row.name, counts: emptyCounts(), total: 0, status: null };
    if (row.state) {
      app.counts[row.state] += row.n;
      app.total += row.n;
    }
    byName.set(row.name, app);
  }
  const list = [...byName.values()]
    .map((app) => ({ ...app, status: worstState(app.counts) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { applications: list };
}

/**
 * Mapa de jornadas: cada jornada tem as aplicações dela; a saúde da jornada é o pior estado entre os
 * alertas dessas aplicações. Uma aplicação pode aparecer em várias jornadas. `unassigned` reúne as
 * aplicações que ainda não estão em nenhuma jornada (nada some do mapa).
 */
export async function getJourneyMap(db: Db) {
  const { applications: apps } = await getApplicationMap(db);
  const byName = new Map(apps.map((a) => [a.name, a]));
  const links = await db
    .select({ journeyId: journeyApplications.journeyId, application: applications.name })
    .from(journeyApplications)
    .innerJoin(applications, eq(applications.id, journeyApplications.applicationId));
  const journeyRows = await db.select().from(journeys).orderBy(asc(journeys.name));

  const inJourney = new Set(links.map((l) => l.application));
  const journeyList: MapJourney[] = journeyRows.map((j) => {
    const members = links
      .filter((l) => l.journeyId === j.id)
      .map((l) => byName.get(l.application))
      .filter((a): a is MapApplication => a !== undefined)
      .sort((a, b) => bySeverityDesc(a.status, b.status) || a.name.localeCompare(b.name));
    const counts = sumCounts(members.map((m) => m.counts));
    return { id: j.id, name: j.name, description: j.description, applications: members, counts, total: members.reduce((s, m) => s + m.total, 0), status: worstState(counts) };
  });
  journeyList.sort((a, b) => bySeverityDesc(a.status, b.status) || a.name.localeCompare(b.name));
  const unassigned = apps.filter((a) => !inJourney.has(a.name)).sort((a, b) => bySeverityDesc(a.status, b.status) || a.name.localeCompare(b.name));
  return { journeys: journeyList, unassigned, totalApplications: apps.length };
}

export async function getJourneyDetail(db: Db, id: number) {
  const { journeys: all } = await getJourneyMap(db);
  const journey = all.find((j) => j.id === id);
  if (!journey) return null;
  const names = journey.applications.map((a) => a.name);
  const items = names.length
    ? await db
        .select({
          id: alerts.id,
          name: alerts.name,
          state: alerts.state,
          priority: alerts.priority,
          application: applications.name,
          stateChangedAt: alerts.stateChangedAt,
          mutedUntil: alerts.mutedUntil,
        })
        .from(alerts)
        .innerJoin(applications, eq(applications.id, alerts.applicationId))
        .where(and(isNull(alerts.archivedAt), inArray(applications.name, names)))
        // Mais graves primeiro: o que está quebrando a jornada aparece no topo.
        .orderBy(sql`case ${alerts.state} when 'alert' then 0 when 'warn' then 1 when 'no_data' then 2 else 3 end`, desc(alerts.stateChangedAt))
        .limit(300)
    : [];
  return { journey, alerts: items };
}

export async function listApplicationNames(db: Db) {
  const rows = await db.select({ name: applications.name }).from(applications).orderBy(asc(applications.name));
  return rows.map((r) => r.name);
}

export type ListAlertsParams = { state?: AlertState; application?: string; search?: string; limit?: number; before?: number };

const alertColumns = {
  id: alerts.id,
  name: alerts.name,
  state: alerts.state,
  priority: alerts.priority,
  application: applications.name,
  provider: alerts.provider,
  externalId: alerts.externalId,
  stateChangedAt: alerts.stateChangedAt,
  archivedAt: alerts.archivedAt,
  mutedUntil: alerts.mutedUntil,
};

/** Listagem com paginação por cursor (id decrescente): custo constante em tabelas grandes. */
export async function listAlerts(db: Db, params: ListAlertsParams = {}) {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const escaped = params.search?.replace(/[\\%_]/g, (c) => `\\${c}`);
  const rows = await db
    .select(alertColumns)
    .from(alerts)
    .innerJoin(applications, eq(applications.id, alerts.applicationId))
    .where(
      and(
        isNull(alerts.archivedAt),
        params.state ? eq(alerts.state, params.state) : undefined,
        params.application ? eq(applications.name, params.application) : undefined,
        escaped ? ilike(alerts.name, `%${escaped}%`) : undefined,
        params.before ? lt(alerts.id, params.before) : undefined,
      ),
    )
    .orderBy(desc(alerts.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
}

export async function getAlertDetail(db: Db, id: number) {
  const [alert] = await db
    .select({ ...alertColumns, applicationId: alerts.applicationId, mutedScope: alerts.mutedScope, muteReason: alerts.muteReason, mutedBy: alerts.mutedBy, mutedAt: alerts.mutedAt, tags: alerts.tags, link: alerts.link, lastEventAt: alerts.lastEventAt, createdAt: alerts.createdAt })
    .from(alerts)
    .innerJoin(applications, eq(applications.id, alerts.applicationId))
    .where(eq(alerts.id, id));
  if (!alert) return null;
  const [remediationList, runs, audit, memberOf] = await Promise.all([
    db.select().from(remediations).where(eq(remediations.alertId, id)).orderBy(remediations.id),
    db.select().from(remediationRuns).where(eq(remediationRuns.alertId, id)).orderBy(desc(remediationRuns.id)).limit(50),
    db.select().from(auditLog).where(eq(auditLog.alertId, id)).orderBy(desc(auditLog.id)).limit(200),
    db
      .select({ id: journeys.id, name: journeys.name })
      .from(journeyApplications)
      .innerJoin(journeys, eq(journeys.id, journeyApplications.journeyId))
      .where(eq(journeyApplications.applicationId, alert.applicationId))
      .orderBy(asc(journeys.name)),
  ]);
  return { alert, remediations: remediationList, runs, audit, journeys: memberOf };
}

export async function getApplicationDetail(db: Db, name: string) {
  const { applications: list } = await getApplicationMap(db);
  const application = list.find((a) => a.name === name);
  if (!application) return null;
  const { items } = await listAlerts(db, { application: name, limit: 200 });
  const memberOf = await db
    .select({ id: journeys.id, name: journeys.name })
    .from(journeyApplications)
    .innerJoin(journeys, eq(journeys.id, journeyApplications.journeyId))
    .innerJoin(applications, eq(applications.id, journeyApplications.applicationId))
    .where(eq(applications.name, name))
    .orderBy(asc(journeys.name));
  return { application, alerts: items, journeys: memberOf };
}

/** Últimas mudanças de estado do sistema inteiro (alertas arquivados incluídos: é histórico). */
export async function getRecentChanges(db: Db, limit = 8) {
  return db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      alertId: alerts.id,
      alertName: alerts.name,
      application: applications.name,
      fromState: auditLog.fromState,
      toState: auditLog.toState,
    })
    .from(auditLog)
    .innerJoin(alerts, eq(alerts.id, auditLog.alertId))
    .innerJoin(applications, eq(applications.id, alerts.applicationId))
    .where(eq(auditLog.kind, "state_changed"))
    .orderBy(desc(auditLog.id))
    .limit(Math.min(Math.max(limit, 1), 50));
}
