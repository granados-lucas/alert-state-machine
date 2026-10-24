import { and, eq } from "drizzle-orm";
import { alerts, applications, auditLog, webhookEvents } from "@/db/schema";
import { transition, type AlertState } from "@/domain/alert-machine";
import type { NormalizedEvent } from "@/providers/types";
import type { Db, Tx } from "./db-types";
import { findTriggered, type PendingRemediation } from "./remediation";

export type IngestResult =
  | { status: "duplicate" }
  | {
      status: "processed";
      outcome: "applied" | "unchanged" | "stale" | "ignored";
      alertId: number;
      from: AlertState;
      to: AlertState;
      pending: PendingRemediation[];
    };

async function upsertApplication(tx: Tx, name: string) {
  const [row] = await tx
    .insert(applications)
    .values({ name })
    .onConflictDoUpdate({ target: applications.name, set: { name } })
    .returning({ id: applications.id });
  return row.id;
}

/**
 * Aplica um evento normalizado. Idempotente por (provider, externalEventId) e serializado por
 * alerta (SELECT ... FOR UPDATE), então entregas repetidas ou concorrentes não duplicam transições.
 */
export async function ingestEvent(db: Db, event: NormalizedEvent): Promise<IngestResult> {
  const actor = `system:${event.provider}`;
  return db.transaction(async (tx) => {
    // 1. Registro do evento: o conflito é a checagem de idempotência.
    const [stored] = await tx
      .insert(webhookEvents)
      .values({
        provider: event.provider,
        externalEventId: event.externalEventId,
        outcome: "ignored",
        occurredAt: event.occurredAt,
        payload: event.raw ?? {},
      })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    if (!stored) return { status: "duplicate" } as const;

    // 2. Aplicação e alerta (descoberta automática no primeiro evento).
    const applicationId = await upsertApplication(tx, event.application);
    const [created] = await tx
      .insert(alerts)
      .values({
        applicationId,
        provider: event.provider,
        externalId: event.externalAlertId,
        name: event.alertName,
        priority: event.priority,
        tags: event.tags,
        link: event.link,
      })
      .onConflictDoNothing()
      .returning({ id: alerts.id });
    const [alert] = await tx
      .select()
      .from(alerts)
      .where(and(eq(alerts.provider, event.provider), eq(alerts.externalId, event.externalAlertId)))
      .for("update");
    if (created) {
      await tx.insert(auditLog).values({
        kind: "alert_created",
        actor,
        alertId: alert.id,
        applicationId,
        eventId: stored.id,
        details: { source: "webhook", externalId: event.externalAlertId, name: event.alertName },
      });
    }

    // 3. Decisão: evento antigo, sem efeito ou transição real.
    const stale = alert.lastEventAt !== null && event.occurredAt < alert.lastEventAt;
    const result = event.event && !stale && !alert.archivedAt ? transition(alert.state, event.event) : null;
    const outcome = stale ? "stale" : result?.kind === "changed" ? "applied" : result?.kind === "unchanged" ? "unchanged" : "ignored";
    const to = result?.kind === "changed" ? result.to : alert.state;

    if (!stale && !alert.archivedAt) {
      const moved = alert.applicationId !== applicationId;
      await tx
        .update(alerts)
        .set({
          state: to,
          stateChangedAt: result?.kind === "changed" ? new Date() : alert.stateChangedAt,
          lastEventAt: event.occurredAt,
          applicationId,
          name: event.alertName,
          priority: event.priority,
          tags: event.tags,
          link: event.link,
          updatedAt: new Date(),
        })
        .where(eq(alerts.id, alert.id));
      if (moved) {
        await tx.insert(auditLog).values({
          kind: "alert_updated",
          actor,
          alertId: alert.id,
          applicationId,
          eventId: stored.id,
          details: { changes: { applicationId: { from: alert.applicationId, to: applicationId } } },
        });
      }
    }
    if (result?.kind === "changed") {
      await tx.insert(auditLog).values({
        kind: "state_changed",
        actor,
        alertId: alert.id,
        applicationId,
        fromState: alert.state,
        toState: to,
        eventId: stored.id,
        details: { event: result.event, occurredAt: event.occurredAt.toISOString() },
      });
    }

    await tx.update(webhookEvents).set({ outcome, alertId: alert.id }).where(eq(webhookEvents.id, stored.id));

    const pending =
      result?.kind === "changed"
        ? (await findTriggered(tx, alert.id, to)).map((remediation) => ({
            remediation,
            state: to,
            previousState: alert.state,
            eventId: stored.id,
          }))
        : [];
    return { status: "processed", outcome, alertId: alert.id, from: alert.state, to, pending } as const;
  });
}
