import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { alerts, auditLog, reconciliationRuns } from "@/db/schema";
import { transition } from "@/domain/alert-machine";
import { ProviderRateLimitError, type AlertProvider, type NormalizedEvent, type ProviderMonitor, type RateLimitInfo } from "@/providers/types";
import type { Db } from "./db-types";
import { ConflictError, NotConfiguredError, NotFoundError, UnsupportedError } from "./errors";
import { ingestEvent } from "./ingest";
import type { PendingRemediation } from "./remediation";

export const reconcileOptionsSchema = z.object({
  provider: z.literal("datadog").default("datadog"),
  // Prévia: calcula e relata o que mudaria, sem alterar alertas.
  dryRun: z.boolean().default(false),
  // Cria alertas para monitores que o provedor lista e a aplicação ainda não conhece.
  createMissing: z.boolean().default(true),
  // Executa as remediações dos alertas que a reconciliação levar a um estado que as dispara.
  remediate: z.boolean().default(true),
  // Filtro do provedor (ex.: service:checkout). Com filtro, "ausentes" não é calculado.
  tags: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  // O limite máximo de page_size do Datadog não está nas páginas lidas: 1000 é só um teto defensivo nosso.
  pageSize: z.number().int().min(10).max(1000).default(100),
  maxPages: z.number().int().min(1).max(500).default(200),
});
export type ReconcileOptions = z.infer<typeof reconcileOptionsSchema>;

export type ReconcileDeps = {
  getProvider: (id: string) => AlertProvider | undefined;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  runRemediations?: (pending: PendingRemediation[]) => Promise<void>;
  maxDurationMs?: number;
};

const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_RATE_LIMIT_WAIT_S = 120; // espera máxima por 429, mesmo que o provedor peça mais
const DEFAULT_MAX_DURATION_MS = 10 * 60_000;
const STALE_RUN_MS = 30 * 60_000; // execução "running" mais velha que isso é considerada abandonada
const DETAIL_LIMIT = 100;

type Detail = { externalId: string; name: string; action: "corrected" | "created" | "kept" | "missing" | "stale"; from?: string; to?: string; raw?: string | null };

const emptySummary = () => ({
  pages: 0,
  requests: 0,
  rateLimited: 0, // respostas 429 absorvidas esperando o reset
  seen: 0,
  inSync: 0,
  corrected: 0,
  created: 0,
  kept: 0, // estado do provedor sem equivalente (Skipped, Ignored...): mantido
  stale: 0, // um webhook mais novo chegou durante a leitura: o dado lido foi descartado
  archived: 0,
  skipped: 0, // monitor desconhecido com createMissing desligado
  missing: 0, // alertas ativos que o provedor não listou (só relatados)
  details: [] as Detail[],
});

const isUniqueViolation = (error: unknown) => {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
};

/** Cria o registro da execução (no máximo uma por provedor) e valida que o provedor sabe listar monitores. */
export async function startReconciliation(db: Db, input: ReconcileOptions, actor: string, trigger: "manual" | "schedule", deps: ReconcileDeps) {
  const provider = deps.getProvider(input.provider);
  if (!provider) throw new UnsupportedError(`provider ${input.provider} is not supported`);
  if (!provider.source) throw new NotConfiguredError("the provider API is not configured (DD_API_KEY / DD_APP_KEY)");
  const now = (deps.now ?? (() => new Date()))();
  try {
    return await db.transaction(async (tx) => {
      // Uma execução que morreu com o processo não pode bloquear as próximas para sempre.
      await tx
        .update(reconciliationRuns)
        .set({ status: "failed", error: "abandoned: the process stopped before finishing", finishedAt: now })
        .where(and(eq(reconciliationRuns.provider, input.provider), eq(reconciliationRuns.status, "running"), lt(reconciliationRuns.startedAt, new Date(now.getTime() - STALE_RUN_MS))));
      const [run] = await tx
        .insert(reconciliationRuns)
        .values({ provider: input.provider, trigger, actor, dryRun: input.dryRun, options: input, startedAt: now })
        .returning();
      return run;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("a reconciliation is already running for this provider");
    throw error;
  }
}

/** Executa a reconciliação de uma execução já criada. Nunca lança: o resultado fica no registro. */
export async function executeReconciliation(db: Db, runId: number, input: ReconcileOptions, deps: ReconcileDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  const started = now();
  const summary = emptySummary();
  let rateLimit: RateLimitInfo = {};
  let status: "succeeded" | "partial" | "failed" = "succeeded";
  let error: string | null = null;
  const actor = "system:reconciliation";
  const addDetail = (d: Detail) => {
    if (summary.details.length < DETAIL_LIMIT) summary.details.push(d);
  };

  try {
    const provider = deps.getProvider(input.provider);
    if (!provider?.source) throw new NotConfiguredError("the provider API is not configured");
    const source = provider.source;
    const seen = new Set<string>();
    let complete = false;

    for (let page = 0; page < input.maxPages; page++) {
      if (now().getTime() - started.getTime() > (deps.maxDurationMs ?? DEFAULT_MAX_DURATION_MS)) {
        status = "partial";
        error = "time budget exhausted before the last page";
        break;
      }
      // Respeita o limite de uso: 429 espera o reset dos cabeçalhos X-RateLimit-* e tenta de novo.
      const fetchedAt = now(); // o estado lido vale a partir daqui; um webhook mais novo vence (stale)
      let result: Awaited<ReturnType<typeof source.listMonitors>> | undefined;
      for (let attempt = 0; !result; attempt++) {
        summary.requests += 1;
        try {
          result = await source.listMonitors({ page, pageSize: input.pageSize, tags: input.tags.length ? input.tags : undefined });
        } catch (e) {
          if (!(e instanceof ProviderRateLimitError) || attempt >= MAX_RATE_LIMIT_RETRIES) throw e;
          rateLimit = e.rateLimit;
          summary.rateLimited += 1;
          const wait = Math.min(Math.max(e.rateLimit.resetSeconds ?? e.rateLimit.period ?? 10, 1), MAX_RATE_LIMIT_WAIT_S);
          await sleep((wait + 1) * 1000);
        }
      }
      rateLimit = result.rateLimit;
      summary.pages += 1;

      const pending = await processPage(db, runId, input, provider.id, result.monitors, seen, fetchedAt, summary, addDetail, actor);
      if (pending.length && input.remediate && deps.runRemediations) await deps.runRemediations(pending);

      if (result.monitors.length < input.pageSize) {
        complete = true;
        break;
      }
      // Quase sem cota: espera o reset antes da próxima página, em vez de provocar um 429.
      const { remaining, resetSeconds } = result.rateLimit;
      if (remaining !== undefined && remaining <= 1 && resetSeconds) await sleep((Math.min(resetSeconds, MAX_RATE_LIMIT_WAIT_S) + 1) * 1000);
    }

    if (!complete && status === "succeeded") {
      status = "partial";
      error = `page limit (${input.maxPages}) reached before the last page`;
    }
    // "Ausentes" só faz sentido com a listagem completa e sem filtro.
    if (complete && input.tags.length === 0) {
      const active = await db
        .select({ externalId: alerts.externalId, name: alerts.name, state: alerts.state })
        .from(alerts)
        .where(and(eq(alerts.provider, provider.id), isNull(alerts.archivedAt)));
      for (const row of active) {
        if (seen.has(row.externalId)) continue;
        summary.missing += 1;
        addDetail({ externalId: row.externalId, name: row.name, action: "missing", from: row.state });
      }
    }
  } catch (e) {
    status = "failed";
    error = e instanceof Error ? e.message.slice(0, 300) : "unknown error";
  }

  const finished = now();
  const [run] = await db
    .update(reconciliationRuns)
    .set({ status, summary, rateLimit, error, finishedAt: finished })
    .where(eq(reconciliationRuns.id, runId))
    .returning();
  await db.insert(auditLog).values({
    kind: "reconciliation_run",
    actor: run.actor,
    details: { runId, provider: input.provider, status, dryRun: input.dryRun, trigger: run.trigger, counts: { ...summary, details: undefined }, error },
  });
  return run;
}

async function processPage(
  db: Db,
  runId: number,
  input: ReconcileOptions,
  providerId: string,
  monitors: ProviderMonitor[],
  seen: Set<string>,
  fetchedAt: Date,
  summary: ReturnType<typeof emptySummary>,
  addDetail: (d: Detail) => void,
  actor: string,
): Promise<PendingRemediation[]> {
  const fresh = monitors.filter((m) => !seen.has(m.externalId));
  for (const m of fresh) seen.add(m.externalId);
  summary.seen += fresh.length;
  if (fresh.length === 0) return [];

  const rows = await db
    .select({
      id: alerts.id,
      externalId: alerts.externalId,
      state: alerts.state,
      archivedAt: alerts.archivedAt,
      link: alerts.link,
      providerState: alerts.providerState,
    })
    .from(alerts)
    .where(and(eq(alerts.provider, providerId), inArray(alerts.externalId, fresh.map((m) => m.externalId))));
  const byExternal = new Map(rows.map((r) => [r.externalId, r]));
  const pending: PendingRemediation[] = [];
  const recordRaw: { id: number; raw: string }[] = [];

  for (const m of fresh) {
    const row = byExternal.get(m.externalId);
    if (row?.archivedAt) {
      summary.archived += 1;
      continue;
    }
    if (!row && !input.createMissing) {
      summary.skipped += 1;
      continue;
    }
    if (row && m.event === null) {
      summary.kept += 1;
      addDetail({ externalId: m.externalId, name: m.name, action: "kept", from: row.state, raw: m.rawState });
    } else if (row && transition(row.state, m.event!).kind !== "changed") {
      summary.inSync += 1;
    } else if (input.dryRun) {
      // Prévia: conta o que aconteceria sem tocar nos alertas.
      if (row) summary.corrected += 1;
      else summary.created += 1;
      addDetail({ externalId: m.externalId, name: m.name, action: row ? "corrected" : "created", from: row?.state, to: m.event ?? "no_data", raw: m.rawState });
    } else {
      const event: NormalizedEvent = {
        provider: providerId,
        externalEventId: `reconcile:${runId}:${m.externalId}`,
        externalAlertId: m.externalId,
        alertName: m.name,
        application: m.application,
        event: m.event,
        occurredAt: fetchedAt,
        priority: m.priority,
        tags: m.tags,
        link: row?.link ?? null,
        raw: { source: "reconciliation", runId, state: m.rawState },
      };
      const result = await ingestEvent(db, event, { actor });
      if (result.status === "processed") {
        if (result.outcome === "applied" || (!row && result.outcome === "ignored")) {
          if (row) summary.corrected += 1;
          else summary.created += 1;
          addDetail({ externalId: m.externalId, name: m.name, action: row ? "corrected" : "created", from: row?.state, to: result.to, raw: m.rawState });
        } else if (result.outcome === "stale") {
          summary.stale += 1;
          addDetail({ externalId: m.externalId, name: m.name, action: "stale", from: row?.state, raw: m.rawState });
        } else if (!row) {
          summary.created += 1; // alerta novo que já nasceu no estado equivalente
          addDetail({ externalId: m.externalId, name: m.name, action: "created", to: result.to, raw: m.rawState });
        } else {
          summary.inSync += 1;
        }
        pending.push(...result.pending);
        if (m.rawState && !input.dryRun) recordRaw.push({ id: result.alertId, raw: m.rawState });
      }
      continue;
    }
    if (row && m.rawState && m.rawState !== row.providerState && !input.dryRun) recordRaw.push({ id: row.id, raw: m.rawState });
  }

  // Guarda o estado bruto lido (a tela mostra "estado no provedor") sem tocar em mais nada.
  for (const { id, raw } of recordRaw) {
    await db.update(alerts).set({ providerState: raw, providerStateAt: fetchedAt }).where(eq(alerts.id, id));
  }
  return pending;
}

/** Início + execução; devolve o registro final (usado por testes e pela rota em segundo plano). */
export async function reconcile(db: Db, input: ReconcileOptions, actor: string, trigger: "manual" | "schedule", deps: ReconcileDeps) {
  const run = await startReconciliation(db, input, actor, trigger, deps);
  return executeReconciliation(db, run.id, input, deps);
}

export async function getReconciliationRun(db: Db, id: number) {
  const [run] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, id));
  if (!run) throw new NotFoundError("reconciliation run not found");
  return run;
}

export async function listReconciliationRuns(db: Db, limit = 20) {
  return db.select().from(reconciliationRuns).orderBy(desc(reconciliationRuns.id)).limit(Math.min(Math.max(limit, 1), 100));
}
