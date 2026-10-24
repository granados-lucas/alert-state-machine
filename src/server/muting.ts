import { eq } from "drizzle-orm";
import { z } from "zod";
import { alerts, applications, auditLog } from "@/db/schema";
import { MUTE_MAX_MINUTES, MUTE_MIN_MINUTES, muteUntil } from "@/domain/mute";
import { ProviderApiError, type AlertProvider, type MonitorSnapshot, type NormalizedEvent } from "@/providers/types";
import type { Db } from "./db-types";
import { NotConfiguredError, NotFoundError, UnsupportedError, ValidationError } from "./errors";
import { ingestEvent, type IngestResult } from "./ingest";

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

async function load(db: Db, id: number, deps: MuteDeps) {
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
  if (alert.archivedAt) throw new ValidationError("archived alerts cannot be muted");
  const provider = deps.getProvider(alert.provider);
  if (!provider) throw new UnsupportedError(`provider ${alert.provider} is not supported`);
  if (!provider.control) throw new NotConfiguredError("the provider API is not configured (DD_API_KEY / DD_APP_KEY)");
  return { alert, control: provider.control };
}

async function recordFailure(db: Db, alert: { id: number; applicationId: number }, actor: string, action: "mute" | "unmute", error: unknown, extra: Record<string, unknown>) {
  const status = error instanceof ProviderApiError ? error.status : null;
  const message = error instanceof Error ? error.message : "unknown error";
  await db.insert(auditLog).values({
    kind: "monitor_mute_failed",
    actor,
    alertId: alert.id,
    applicationId: alert.applicationId,
    details: { action, status, message, ...extra },
  });
}

// O provedor informa o estado atual do monitor ao responder. Durante um silêncio ele não envia
// webhooks, então o estado daqui pode estar atrasado: aplicamos o estado informado como um evento.
async function syncState(db: Db, alert: Awaited<ReturnType<typeof load>>["alert"], snapshot: MonitorSnapshot, now: Date, action: string): Promise<IngestResult | null> {
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

export async function muteAlert(db: Db, id: number, input: z.infer<typeof muteSchema>, actor: string, deps: MuteDeps) {
  const { alert, control } = await load(db, id, deps);
  const now = (deps.now ?? (() => new Date()))();
  const until = muteUntil(input.minutes, now);
  let snapshot: MonitorSnapshot;
  try {
    snapshot = await control.mute(alert.externalId, { until, scope: input.scope });
  } catch (error) {
    await recordFailure(db, alert, actor, "mute", error, { reason: input.reason, until: until.toISOString(), scope: input.scope ?? null });
    throw error;
  }
  await db.transaction(async (tx) => {
    await tx
      .update(alerts)
      .set({
        mutedUntil: until,
        mutedScope: input.scope ?? null,
        muteReason: input.reason,
        mutedBy: actor,
        mutedAt: now,
        updatedAt: now,
        ...(snapshot.rawState ? { providerState: snapshot.rawState, providerStateAt: now } : {}),
      })
      .where(eq(alerts.id, id));
    await tx.insert(auditLog).values({
      kind: "monitor_muted",
      actor,
      alertId: id,
      applicationId: alert.applicationId,
      details: { reason: input.reason, minutes: input.minutes, until: until.toISOString(), scope: input.scope ?? null, providerState: snapshot.rawState },
    });
  });
  const sync = await syncState(db, alert, snapshot, now, "mute");
  return { mutedUntil: until, scope: input.scope ?? null, reason: input.reason, synced: sync?.status === "processed" ? sync : null };
}

export async function unmuteAlert(db: Db, id: number, input: z.infer<typeof unmuteSchema>, actor: string, deps: MuteDeps) {
  const { alert, control } = await load(db, id, deps);
  const now = (deps.now ?? (() => new Date()))();
  const scope = input.allScopes ? undefined : (alert.mutedScope ?? undefined);
  let snapshot: MonitorSnapshot;
  try {
    snapshot = await control.unmute(alert.externalId, { scope, allScopes: input.allScopes });
  } catch (error) {
    await recordFailure(db, alert, actor, "unmute", error, { reason: input.reason ?? null });
    throw error;
  }
  await db.transaction(async (tx) => {
    await tx
      .update(alerts)
      .set({
        mutedUntil: null,
        mutedScope: null,
        muteReason: null,
        mutedBy: null,
        mutedAt: null,
        updatedAt: now,
        ...(snapshot.rawState ? { providerState: snapshot.rawState, providerStateAt: now } : {}),
      })
      .where(eq(alerts.id, id));
    await tx.insert(auditLog).values({
      kind: "monitor_unmuted",
      actor,
      alertId: id,
      applicationId: alert.applicationId,
      details: { reason: input.reason ?? null, scope: scope ?? null, allScopes: input.allScopes, providerState: snapshot.rawState },
    });
  });
  const sync = await syncState(db, alert, snapshot, now, "unmute");
  return { mutedUntil: null, synced: sync?.status === "processed" ? sync : null };
}
