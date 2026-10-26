import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { alerts, applications, auditLog, muteOperations } from "@/db/schema";
import { MUTE_MAX_MINUTES, MUTE_MIN_MINUTES, muteUntil } from "@/domain/mute";
import { increment } from "@/lib/metrics";
import { ProviderApiError, ProviderRateLimitError, type AlertProvider, type MonitorControl, type MonitorSnapshot, type NormalizedEvent } from "@/providers/types";
import type { Db } from "./db-types";
import { ConflictError, isUniqueViolation, NotConfiguredError, NotFoundError, UnsupportedError, ValidationError } from "./errors";
import { ingestEvent, type IngestResult } from "./ingest";

/**
 * SILENCIAR/REATIVAR COM CONSISTÊNCIA ENTRE O PROVEDOR E O BANCO.
 * Não existe transação entre os dois sistemas; o que garantimos é que a divergência nunca é silenciosa:
 *  1. grava a INTENÇÃO (mute_operations, "pending") em uma transação que trava o alerta;
 *  2. chama o provedor (idempotente: repetir com os mesmos parâmetros dá o mesmo resultado);
 *  3. numa única transação grava o resultado no alerta, fecha a operação e audita.
 * Se o processo cair entre 2 e 3, a operação continua "pending" e é REEXECUTADA (`recoverMuteOperations`):
 * ao fim, o provedor e o banco concordam ou a operação fica "failed" com o motivo.
 */
export const muteSchema = z.object({
  minutes: z.number().int().min(MUTE_MIN_MINUTES).max(MUTE_MAX_MINUTES),
  // Motivo obrigatório: é o que a auditoria mostra a quem investigar depois.
  reason: z.string().trim().min(3).max(300),
  scope: z.string().trim().min(1).max(200).optional(),
});

export const unmuteSchema = z.object({
  reason: z.string().trim().max(300).optional(),
  // Limpa o silêncio em todos os escopos (inclusive os criados direto no provedor).
  allScopes: z.boolean().default(false),
});

export type MuteDeps = { getProvider: (id: string) => AlertProvider | undefined; now?: () => Date };

/** Uma operação pendente mais nova que isso ainda pode estar em andamento: outra requisição espera (409). */
export const PENDING_GRACE_MS = 60_000;

type Operation = typeof muteOperations.$inferSelect;
type AlertInfo = Awaited<ReturnType<typeof loadAlert>>;

const clock = (deps: MuteDeps) => (deps.now ?? (() => new Date()))();

async function loadAlert(db: Db, id: number) {
  const [alert] = await db
    .select({
      id: alerts.id,
      name: alerts.name,
      provider: alerts.provider,
      externalId: alerts.externalId,
      priority: alerts.priority,
      tags: alerts.tags,
      link: alerts.link,
      archivedAt: alerts.archivedAt,
      mutedScope: alerts.mutedScope,
      application: applications.name,
      applicationId: alerts.applicationId,
    })
    .from(alerts)
    .innerJoin(applications, eq(applications.id, alerts.applicationId))
    .where(eq(alerts.id, id));
  if (!alert) throw new NotFoundError("alert not found");
  return alert;
}

function controlFor(alert: { provider: string }, deps: MuteDeps): MonitorControl {
  const provider = deps.getProvider(alert.provider);
  if (!provider) throw new UnsupportedError(`provider ${alert.provider} is not supported`);
  if (!provider.control) throw new NotConfiguredError("the provider API is not configured (DD_API_KEY / DD_APP_KEY)");
  return provider.control;
}

type Request = { action: "mute" | "unmute"; actor: string; reason: string | null; minutes?: number; until?: Date; scope?: string; allScopes?: boolean };

/** Passo 1: registra a intenção. Devolve a operação nova, ou a pendente antiga (a recuperar). */
async function begin(db: Db, alertId: number, request: Request, now: Date): Promise<{ op: Operation } | { stale: Operation }> {
  try {
    return await db.transaction(async (tx) => {
      await tx.select({ id: alerts.id }).from(alerts).where(eq(alerts.id, alertId)).for("update");
      const [pending] = await tx.select().from(muteOperations).where(and(eq(muteOperations.alertId, alertId), eq(muteOperations.status, "pending")));
      if (pending) {
        if (now.getTime() - pending.createdAt.getTime() < PENDING_GRACE_MS) {
          throw new ConflictError("another mute operation is in progress for this alert; try again in a minute");
        }
        return { stale: pending };
      }
      const [op] = await tx
        .insert(muteOperations)
        .values({ alertId, action: request.action, actor: request.actor, reason: request.reason, minutes: request.minutes ?? null, until: request.until ?? null, scope: request.scope ?? null, allScopes: request.allScopes ?? false, createdAt: now })
        .returning();
      return { op };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("another mute operation is in progress for this alert");
    throw error;
  }
}

/** Passo 3 (sucesso): resultado no alerta + operação fechada + auditoria, tudo na mesma transação. */
async function commit(db: Db, op: Operation, alert: AlertInfo, snapshot: MonitorSnapshot, now: Date) {
  const closedHere = await db.transaction(async (tx) => {
    // Só quem fecha a operação grava o resultado: uma recuperação concorrente que chegou depois não duplica nada.
    const closed = await tx
      .update(muteOperations)
      .set({ status: "succeeded", recovered: op.recovered, finishedAt: now })
      .where(and(eq(muteOperations.id, op.id), eq(muteOperations.status, "pending")))
      .returning({ id: muteOperations.id });
    if (closed.length === 0) return false;
    const providerState = snapshot.rawState ? { providerState: snapshot.rawState, providerStateAt: now } : {};
    if (op.action === "mute") {
      await tx
        .update(alerts)
        .set({ mutedUntil: op.until, mutedScope: op.scope, muteReason: op.reason, mutedBy: op.actor, mutedAt: op.createdAt, updatedAt: now, ...providerState })
        .where(eq(alerts.id, alert.id));
    } else {
      await tx.update(alerts).set({ mutedUntil: null, mutedScope: null, muteReason: null, mutedBy: null, mutedAt: null, updatedAt: now, ...providerState }).where(eq(alerts.id, alert.id));
    }
    await tx.insert(auditLog).values({
      kind: op.action === "mute" ? "monitor_muted" : "monitor_unmuted",
      actor: op.actor,
      alertId: alert.id,
      applicationId: alert.applicationId,
      details:
        op.action === "mute"
          ? { reason: op.reason, minutes: op.minutes, until: op.until?.toISOString(), scope: op.scope, providerState: snapshot.rawState, operationId: op.id, recovered: op.recovered }
          : { reason: op.reason, scope: op.scope, allScopes: op.allScopes, providerState: snapshot.rawState, operationId: op.id, recovered: op.recovered },
    });
    return true;
  });
  if (closedHere) increment("mute_operations_total", { action: op.action, status: "succeeded" });
}

/** Passo 3 (falha do provedor): fecha a operação como "failed" e audita; o alerta não muda. */
async function fail(db: Db, op: Operation, alert: AlertInfo, error: unknown, now: Date) {
  const status = error instanceof ProviderApiError ? error.status : null;
  const message = error instanceof Error ? error.message : "unknown error";
  const closedHere = await db.transaction(async (tx) => {
    const closed = await tx
      .update(muteOperations)
      .set({ status: "failed", recovered: op.recovered, error: message.slice(0, 300), finishedAt: now })
      .where(and(eq(muteOperations.id, op.id), eq(muteOperations.status, "pending")))
      .returning({ id: muteOperations.id });
    if (closed.length === 0) return false;
    await tx.insert(auditLog).values({
      kind: "monitor_mute_failed",
      actor: op.actor,
      alertId: alert.id,
      applicationId: alert.applicationId,
      details: { action: op.action, status, message, reason: op.reason, until: op.until?.toISOString() ?? null, scope: op.scope, operationId: op.id, recovered: op.recovered },
    });
    return true;
  });
  if (closedHere) increment("mute_operations_total", { action: op.action, status: "failed" });
}

async function callProvider(control: MonitorControl, op: Operation, alert: AlertInfo) {
  const labels = { provider: alert.provider, operation: op.action };
  try {
    const snapshot = await (op.action === "mute"
      ? control.mute(alert.externalId, { until: op.until as Date, scope: op.scope ?? undefined })
      : control.unmute(alert.externalId, { scope: op.scope ?? undefined, allScopes: op.allScopes }));
    increment("provider_api_requests_total", { ...labels, outcome: "ok" });
    return snapshot;
  } catch (error) {
    increment("provider_api_requests_total", { ...labels, outcome: error instanceof ProviderRateLimitError ? "rate_limited" : "error" });
    throw error;
  }
}

// O provedor informa o estado atual do monitor ao responder. Durante um silêncio ele não envia
// webhooks, então o estado daqui pode estar atrasado: aplicamos o estado informado como um evento.
async function syncState(db: Db, alert: AlertInfo, snapshot: MonitorSnapshot, now: Date, action: string): Promise<IngestResult | null> {
  if (!snapshot.event) return null;
  const event: NormalizedEvent = {
    provider: alert.provider,
    externalEventId: `sync:${action}:${alert.externalId}:${now.getTime()}`,
    externalAlertId: alert.externalId,
    alertName: alert.name,
    application: alert.application,
    event: snapshot.event,
    occurredAt: now,
    priority: alert.priority,
    tags: alert.tags,
    link: alert.link,
    raw: { source: `sync-after-${action}`, state: snapshot.rawState },
  };
  return ingestEvent(db, event);
}

/**
 * Reexecuta uma operação que ficou pendente (a chamada ao provedor é idempotente). Um silêncio cujo fim
 * já passou não é repetido: venceria de qualquer forma, então a operação é encerrada como "failed".
 * Lança se a gravação do resultado falhar de novo (a operação continua pendente).
 */
export async function settleOperation(db: Db, stale: Operation, deps: MuteDeps) {
  const now = clock(deps);
  const alert = await loadAlert(db, stale.alertId);
  const op = { ...stale, recovered: true };
  if (op.action === "mute" && op.until && op.until.getTime() <= now.getTime()) {
    await fail(db, op, alert, new Error("the mute window ended before the operation could be confirmed"), now);
    return { status: "failed" as const, op };
  }
  let snapshot: MonitorSnapshot;
  try {
    snapshot = await callProvider(controlFor(alert, deps), op, alert);
  } catch (error) {
    await fail(db, op, alert, error, now);
    return { status: "failed" as const, op };
  }
  await commit(db, op, alert, snapshot, now);
  const sync = await syncState(db, alert, snapshot, now, op.action);
  return { status: "succeeded" as const, op, synced: sync?.status === "processed" ? sync : null };
}

/** Reexecuta todas as operações pendentes há mais de PENDING_GRACE_MS (chamada pela reconciliação e pela API). */
export async function recoverMuteOperations(db: Db, deps: MuteDeps) {
  const cutoff = new Date(clock(deps).getTime() - PENDING_GRACE_MS);
  const stale = await db.select().from(muteOperations).where(and(eq(muteOperations.status, "pending"), lt(muteOperations.createdAt, cutoff)));
  const result = { found: stale.length, succeeded: 0, failed: 0, errors: 0 };
  for (const op of stale) {
    try {
      const outcome = await settleOperation(db, op, deps);
      result[outcome.status] += 1;
    } catch {
      result.errors += 1; // continua pendente: a próxima recuperação tenta de novo
    }
  }
  return result;
}

async function execute(db: Db, alertId: number, request: Request, deps: MuteDeps) {
  const alert = await loadAlert(db, alertId);
  if (alert.archivedAt) throw new ValidationError("archived alerts cannot be muted");
  const control = controlFor(alert, deps);
  const now = clock(deps);

  let started = await begin(db, alertId, request, now);
  if ("stale" in started) {
    // Uma operação anterior não foi concluída: termina-a antes de aceitar a nova.
    await settleOperation(db, started.stale, deps);
    started = await begin(db, alertId, request, clock(deps));
    if ("stale" in started) throw new ConflictError("another mute operation is in progress for this alert");
  }
  const { op } = started;

  let snapshot: MonitorSnapshot;
  try {
    snapshot = await callProvider(control, op, alert);
  } catch (error) {
    await fail(db, op, alert, error, clock(deps));
    throw error;
  }
  // Se esta transação falhar, a operação segue "pending" e será reexecutada; o erro sobe para o chamador.
  await commit(db, op, alert, snapshot, now);
  const sync = await syncState(db, alert, snapshot, now, request.action);
  return { snapshot, sync: sync?.status === "processed" ? sync : null };
}

export async function muteAlert(db: Db, id: number, input: z.infer<typeof muteSchema>, actor: string, deps: MuteDeps) {
  const until = muteUntil(input.minutes, clock(deps));
  const { sync } = await execute(db, id, { action: "mute", actor, reason: input.reason, minutes: input.minutes, until, scope: input.scope }, deps);
  return { mutedUntil: until, scope: input.scope ?? null, reason: input.reason, synced: sync };
}

export async function unmuteAlert(db: Db, id: number, input: z.infer<typeof unmuteSchema>, actor: string, deps: MuteDeps) {
  const current = await loadAlert(db, id);
  const scope = input.allScopes ? undefined : (current.mutedScope ?? undefined);
  const { sync } = await execute(db, id, { action: "unmute", actor, reason: input.reason ?? null, scope, allScopes: input.allScopes }, deps);
  return { mutedUntil: null, synced: sync };
}

/** Operações de silêncio pendentes (para a tela de status e as métricas). */
export async function listPendingMuteOperations(db: Db) {
  return db.select().from(muteOperations).where(eq(muteOperations.status, "pending"));
}
