import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { alerts, applications, auditLog, remediations } from "@/db/schema";
import { PROVIDER_IDS } from "@/providers/catalog";
import type { Db } from "./db-types";
import { ConflictError, NotFoundError } from "./errors";
import { remediationInputSchema } from "./remediation";

const nameSchema = z.string().trim().min(1).max(200);

export const createAlertSchema = z.object({
  provider: z.enum(PROVIDER_IDS).default("datadog"),
  externalId: z.string().trim().min(1).max(200),
  name: nameSchema,
  application: z.string().trim().min(1).max(100),
  priority: z.number().int().min(1).max(5).nullish(),
  tags: z.array(z.string().max(200)).max(50).default([]),
  link: z.url({ protocol: /^https?$/ }).nullish(),
  remediations: z.array(remediationInputSchema).max(10).default([]),
});
export type CreateAlertInput = z.infer<typeof createAlertSchema>;

export const updateAlertSchema = z
  .object({
    name: nameSchema,
    priority: z.number().int().min(1).max(5).nullable(),
    tags: z.array(z.string().max(200)).max(50),
    link: z.url({ protocol: /^https?$/ }).nullable(),
    archived: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "empty update");
export type UpdateAlertInput = z.infer<typeof updateAlertSchema>;

const remediationRow = (alertId: number, r: z.infer<typeof remediationInputSchema>) => ({
  alertId,
  name: r.name,
  mode: r.mode,
  url: r.url,
  method: r.method,
  headers: r.headers,
  bodyTemplate: r.bodyTemplate ?? null,
  triggerStates: r.triggerStates,
  timeoutMs: r.timeoutMs,
  enabled: r.enabled,
});

/** Cria um alerta (com remediações opcionais). Um monitor já descoberto por webhook gera 409. */
export async function createAlert(db: Db, input: CreateAlertInput, actor: string) {
  return db.transaction(async (tx) => {
    const [app] = await tx
      .insert(applications)
      .values({ name: input.application })
      .onConflictDoUpdate({ target: applications.name, set: { name: input.application } })
      .returning({ id: applications.id });
    const [alert] = await tx
      .insert(alerts)
      .values({
        applicationId: app.id,
        provider: input.provider,
        externalId: input.externalId,
        name: input.name,
        priority: input.priority ?? null,
        tags: input.tags,
        link: input.link ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!alert) throw new ConflictError("alert already exists for this provider and externalId");
    await tx.insert(auditLog).values({
      kind: "alert_created",
      actor,
      alertId: alert.id,
      applicationId: app.id,
      details: { source: "api", externalId: input.externalId, name: input.name, remediations: input.remediations.length },
    });
    for (const r of input.remediations) {
      const [row] = await tx.insert(remediations).values(remediationRow(alert.id, r)).returning({ id: remediations.id });
      await tx.insert(auditLog).values({
        kind: "remediation_created",
        actor,
        alertId: alert.id,
        details: { remediationId: row.id, name: r.name, mode: r.mode, url: r.url, triggerStates: r.triggerStates },
      });
    }
    return alert;
  });
}

/** Atualiza campos do alerta registrando antes/depois na auditoria. */
export async function updateAlert(db: Db, id: number, patch: UpdateAlertInput, actor: string) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(alerts).where(eq(alerts.id, id)).for("update");
    if (!current) throw new NotFoundError("alert not found");
    const { archived, ...fields } = patch;
    const set: Partial<typeof alerts.$inferInsert> = { ...fields, updatedAt: new Date() };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, value] of Object.entries(fields)) {
      const before = current[key as keyof typeof current];
      if (JSON.stringify(before) !== JSON.stringify(value)) changes[key] = { from: before, to: value };
    }
    if (archived !== undefined && archived !== (current.archivedAt !== null)) {
      set.archivedAt = archived ? new Date() : null;
    }
    const archiveChanged = "archivedAt" in set;
    if (Object.keys(changes).length === 0 && !archiveChanged) return current;
    const [updated] = await tx.update(alerts).set(set).where(eq(alerts.id, id)).returning();
    if (Object.keys(changes).length > 0) {
      await tx.insert(auditLog).values({
        kind: "alert_updated",
        actor,
        alertId: id,
        applicationId: current.applicationId,
        details: { changes },
      });
    }
    if (archiveChanged) {
      await tx.insert(auditLog).values({
        kind: "alert_archived",
        actor,
        alertId: id,
        applicationId: current.applicationId,
        details: { archived: Boolean(archived) },
      });
    }
    return updated;
  });
}

export async function addRemediation(db: Db, alertId: number, input: z.infer<typeof remediationInputSchema>, actor: string) {
  return db.transaction(async (tx) => {
    const [alert] = await tx.select({ id: alerts.id }).from(alerts).where(eq(alerts.id, alertId));
    if (!alert) throw new NotFoundError("alert not found");
    const [row] = await tx.insert(remediations).values(remediationRow(alertId, input)).returning();
    await tx.insert(auditLog).values({
      kind: "remediation_created",
      actor,
      alertId,
      details: { remediationId: row.id, name: input.name, mode: input.mode, url: input.url, triggerStates: input.triggerStates },
    });
    return row;
  });
}

export const updateRemediationSchema = z
  .object({ enabled: z.boolean(), triggerStates: remediationInputSchema.shape.triggerStates, timeoutMs: z.number().int().min(100).max(15_000) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "empty update");

export async function updateRemediation(db: Db, alertId: number, remediationId: number, patch: z.infer<typeof updateRemediationSchema>, actor: string) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(remediations)
      .where(and(eq(remediations.id, remediationId), eq(remediations.alertId, alertId)))
      .for("update");
    if (!current) throw new NotFoundError("remediation not found");
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, value] of Object.entries(patch)) {
      const before = current[key as keyof typeof current];
      if (JSON.stringify(before) !== JSON.stringify(value)) changes[key] = { from: before, to: value };
    }
    if (Object.keys(changes).length === 0) return current;
    const [row] = await tx.update(remediations).set({ ...patch, updatedAt: new Date() }).where(eq(remediations.id, remediationId)).returning();
    await tx.insert(auditLog).values({
      kind: "remediation_updated",
      actor,
      alertId,
      details: { remediationId, changes },
    });
    return row;
  });
}
