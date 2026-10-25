import { desc, count, eq, isNull, max, min, sql } from "drizzle-orm";
import { alerts, muteOperations, reconciliationRuns, remediationRuns } from "@/db/schema";
import { ALERT_STATES } from "@/domain/alert-machine";
import type { Gauge } from "@/lib/metrics";
import { PROVIDER_IDS } from "@/providers/catalog";
import type { Db } from "./db-types";

/**
 * Estado da própria aplicação, lido na hora (tela /status e /api/metrics). Vem do banco, não da memória do processo:
 * sobrevive a reinícios e vale com mais de uma instância. Se o banco falhar, `db.up` é falso e o resto fica vazio;
 * quem consulta continua recebendo resposta (o sinal é justamente "banco fora").
 */
export type ProviderStatus = { id: string; webhook: boolean; control: boolean; source: boolean };
export type PoolStats = { total: number; idle: number; waiting: number } | null;

export type Telemetry = {
  db: { up: boolean; latencyMs: number | null };
  pool: PoolStats;
  alertsByState: Record<string, number>;
  providers: (ProviderStatus & { lastEventAt: Date | null })[];
  pendingMutes: { count: number; oldestAt: Date | null };
  lastReconciliation: { id: number; provider: string; status: string; startedAt: Date; finishedAt: Date | null; dryRun: boolean } | null;
  recentRemediations: { total: number; failed: number; skipped: number };
};

const RECENT_REMEDIATIONS = 50;

export async function readTelemetry(db: Db | undefined, options: { providers: ProviderStatus[]; pool?: PoolStats }): Promise<Telemetry> {
  const empty: Telemetry = {
    db: { up: false, latencyMs: null },
    pool: options.pool ?? null,
    alertsByState: Object.fromEntries(ALERT_STATES.map((s) => [s, 0])),
    providers: options.providers.map((p) => ({ ...p, lastEventAt: null })),
    pendingMutes: { count: 0, oldestAt: null },
    lastReconciliation: null,
    recentRemediations: { total: 0, failed: 0, skipped: 0 },
  };
  if (!db) return empty;
  const started = performance.now();
  try {
    await db.execute(sql`select 1`);
    const latencyMs = Math.round(performance.now() - started);
    const [byState, lastEvents, pending, [lastRun], recent] = await Promise.all([
      db.select({ state: alerts.state, n: count() }).from(alerts).where(isNull(alerts.archivedAt)).groupBy(alerts.state),
      db.select({ provider: alerts.provider, at: max(alerts.lastEventAt) }).from(alerts).groupBy(alerts.provider),
      db.select({ n: count(), oldest: min(muteOperations.createdAt) }).from(muteOperations).where(eq(muteOperations.status, "pending")),
      db
        .select({ id: reconciliationRuns.id, provider: reconciliationRuns.provider, status: reconciliationRuns.status, startedAt: reconciliationRuns.startedAt, finishedAt: reconciliationRuns.finishedAt, dryRun: reconciliationRuns.dryRun })
        .from(reconciliationRuns)
        .orderBy(desc(reconciliationRuns.id))
        .limit(1),
      // As últimas N execuções pela chave primária: barato mesmo com a tabela grande.
      db.select({ status: remediationRuns.status }).from(remediationRuns).orderBy(desc(remediationRuns.id)).limit(RECENT_REMEDIATIONS),
    ]);
    const lastAt = new Map(lastEvents.map((row) => [row.provider, row.at]));
    return {
      ...empty,
      db: { up: true, latencyMs },
      alertsByState: { ...empty.alertsByState, ...Object.fromEntries(byState.map((row) => [row.state, row.n])) },
      providers: empty.providers.map((p) => ({ ...p, lastEventAt: lastAt.get(p.id) ?? null })),
      pendingMutes: { count: pending[0]?.n ?? 0, oldestAt: pending[0]?.oldest ?? null },
      lastReconciliation: lastRun ?? null,
      recentRemediations: { total: recent.length, failed: recent.filter((r) => r.status === "failed").length, skipped: recent.filter((r) => r.status === "skipped").length },
    };
  } catch {
    return empty;
  }
}

/** Telemetria no formato de gauges do Prometheus. */
export function toGauges(t: Telemetry, info: { version: string; startedAt: Date; now?: Date }): Gauge[] {
  const now = info.now ?? new Date();
  const gauges: Gauge[] = [
    { name: "build_info", help: "Versão em execução (valor sempre 1).", samples: [{ labels: { version: info.version }, value: 1 }] },
    { name: "process_uptime_seconds", help: "Tempo desde o início do processo.", samples: [{ value: Math.round((now.getTime() - info.startedAt.getTime()) / 1000) }] },
    { name: "process_resident_memory_bytes", help: "Memória residente do processo.", samples: [{ value: process.memoryUsage().rss }] },
    { name: "database_up", help: "1 se o banco respondeu à consulta de teste.", samples: [{ value: t.db.up ? 1 : 0 }] },
    { name: "alerts", help: "Alertas ativos por estado.", samples: Object.entries(t.alertsByState).map(([state, value]) => ({ labels: { state }, value })) },
    {
      name: "last_event_timestamp_seconds",
      help: "Instante do último evento aplicado, por fonte (0 = nenhum). Alerte sobre time() - este valor.",
      samples: PROVIDER_IDS.map((id) => ({ labels: { provider: id }, value: Math.floor((t.providers.find((p) => p.id === id)?.lastEventAt?.getTime() ?? 0) / 1000) })),
    },
    {
      name: "provider_webhook_enabled",
      help: "1 se o segredo do webhook da fonte está configurado.",
      samples: t.providers.map((p) => ({ labels: { provider: p.id }, value: p.webhook ? 1 : 0 })),
    },
    { name: "mute_operations_pending", help: "Operações de silêncio sem desfecho gravado.", samples: [{ value: t.pendingMutes.count }] },
    {
      name: "mute_operations_oldest_pending_seconds",
      help: "Idade da operação de silêncio pendente mais antiga (0 = nenhuma).",
      samples: [{ value: t.pendingMutes.oldestAt ? Math.max(0, Math.round((now.getTime() - t.pendingMutes.oldestAt.getTime()) / 1000)) : 0 }],
    },
    {
      name: "reconciliation_last_run_timestamp_seconds",
      help: "Início da última reconciliação (0 = nunca).",
      samples: [{ value: t.lastReconciliation ? Math.floor(t.lastReconciliation.startedAt.getTime() / 1000) : 0 }],
    },
    { name: "remediation_recent_failed", help: `Falhas entre as últimas ${RECENT_REMEDIATIONS} remediações.`, samples: [{ value: t.recentRemediations.failed }] },
  ];
  if (t.db.latencyMs !== null) gauges.push({ name: "database_latency_seconds", help: "Latência da consulta de teste ao banco.", samples: [{ value: t.db.latencyMs / 1000 }] });
  if (t.pool) {
    gauges.push({
      name: "database_pool_connections",
      help: "Conexões do pool do banco, por situação.",
      samples: [
        { labels: { state: "total" }, value: t.pool.total },
        { labels: { state: "idle" }, value: t.pool.idle },
        { labels: { state: "waiting" }, value: t.pool.waiting },
      ],
    });
  }
  return gauges;
}
