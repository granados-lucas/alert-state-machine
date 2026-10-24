import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { applications, auditLog, journeyApplications, journeys } from "@/db/schema";
import type { Db, Tx } from "./db-types";
import { ConflictError, NotFoundError } from "./errors";

const appName = z.string().trim().min(1).max(100);

export const createJourneySchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullish(),
  // Aplicações ainda não vistas pelo Datadog são criadas aqui: a jornada pode ser desenhada antes dos alertas.
  applications: z.array(appName).max(200).default([]),
});
export type CreateJourneyInput = z.infer<typeof createJourneySchema>;

export const updateJourneySchema = z
  .object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(500).nullable() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "empty update");

export const journeyApplicationsSchema = z.object({ applications: z.array(appName).max(200) });

async function upsertApplications(tx: Tx, names: string[]) {
  if (names.length === 0) return [];
  await tx.insert(applications).values(names.map((name) => ({ name }))).onConflictDoNothing();
  return tx.select({ id: applications.id, name: applications.name }).from(applications).where(inArray(applications.name, names));
}

async function memberNames(tx: Tx, journeyId: number) {
  const rows = await tx
    .select({ name: applications.name })
    .from(journeyApplications)
    .innerJoin(applications, eq(applications.id, journeyApplications.applicationId))
    .where(eq(journeyApplications.journeyId, journeyId));
  return rows.map((r) => r.name).sort();
}

const unique = (names: string[]) => [...new Set(names)].sort();

export async function createJourney(db: Db, input: CreateJourneyInput, actor: string) {
  return db.transaction(async (tx) => {
    const [journey] = await tx
      .insert(journeys)
      .values({ name: input.name, description: input.description ?? null })
      .onConflictDoNothing()
      .returning();
    if (!journey) throw new ConflictError("a journey with this name already exists");
    const names = unique(input.applications);
    const apps = await upsertApplications(tx, names);
    if (apps.length) await tx.insert(journeyApplications).values(apps.map((a) => ({ journeyId: journey.id, applicationId: a.id })));
    await tx.insert(auditLog).values({
      kind: "journey_created",
      actor,
      details: { journeyId: journey.id, name: journey.name, applications: names },
    });
    return { ...journey, applications: names };
  });
}

export async function updateJourney(db: Db, id: number, patch: z.infer<typeof updateJourneySchema>, actor: string) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(journeys).where(eq(journeys.id, id)).for("update");
    if (!current) throw new NotFoundError("journey not found");
    if (patch.name && patch.name !== current.name) {
      const [clash] = await tx.select({ id: journeys.id }).from(journeys).where(and(eq(journeys.name, patch.name), ne(journeys.id, id)));
      if (clash) throw new ConflictError("a journey with this name already exists");
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, value] of Object.entries(patch)) {
      const before = current[key as keyof typeof current];
      if (before !== value) changes[key] = { from: before, to: value };
    }
    if (Object.keys(changes).length === 0) return current;
    const [updated] = await tx.update(journeys).set(patch).where(eq(journeys.id, id)).returning();
    await tx.insert(auditLog).values({ kind: "journey_updated", actor, details: { journeyId: id, changes } });
    return updated;
  });
}

/** Substitui o conjunto de aplicações da jornada; a auditoria guarda o antes e o depois. */
export async function setJourneyApplications(db: Db, id: number, names: string[], actor: string) {
  return db.transaction(async (tx) => {
    const [journey] = await tx.select().from(journeys).where(eq(journeys.id, id)).for("update");
    if (!journey) throw new NotFoundError("journey not found");
    const wanted = unique(names);
    const before = await memberNames(tx, id);
    if (JSON.stringify(before) === JSON.stringify(wanted)) return wanted;
    await tx.delete(journeyApplications).where(eq(journeyApplications.journeyId, id));
    const apps = await upsertApplications(tx, wanted);
    if (apps.length) await tx.insert(journeyApplications).values(apps.map((a) => ({ journeyId: id, applicationId: a.id })));
    await tx.insert(auditLog).values({
      kind: "journey_applications_updated",
      actor,
      details: { journeyId: id, name: journey.name, from: before, to: wanted },
    });
    return wanted;
  });
}

/** Remove a jornada (as aplicações e os alertas permanecem). A auditoria guarda o que existia. */
export async function deleteJourney(db: Db, id: number, actor: string) {
  return db.transaction(async (tx) => {
    const [journey] = await tx.select().from(journeys).where(eq(journeys.id, id)).for("update");
    if (!journey) throw new NotFoundError("journey not found");
    const members = await memberNames(tx, id);
    await tx.delete(journeyApplications).where(eq(journeyApplications.journeyId, id));
    await tx.delete(journeys).where(eq(journeys.id, id));
    await tx.insert(auditLog).values({
      kind: "journey_deleted",
      actor,
      details: { journeyId: id, name: journey.name, description: journey.description, applications: members },
    });
  });
}
