import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { alerts, auditLog } from "@/db/schema";
import { createTestDb } from "@/test/db";
import type { Db } from "./db-types";
import { ConflictError, NotFoundError } from "./errors";
import { ingestEvent } from "./ingest";
import { createJourney, createJourneySchema, deleteJourney, setJourneyApplications, updateJourney } from "./journeys";
import { getAlertDetail, getApplicationDetail, getJourneyDetail, getJourneyMap, listApplicationNames } from "./queries";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const event = (app: string, id: string, kind: "triggered" | "recovered" | "warned") => ({
  provider: "datadog", externalEventId: `${app}-${id}-${kind}`, externalAlertId: `${app}-${id}`, alertName: `${app} ${id}`, application: app,
  event: kind, occurredAt: new Date(), priority: null, tags: [], link: null, raw: {},
});
const make = (input: Record<string, unknown>) => createJourneySchema.parse(input);
const auditKinds = async () => (await db.select().from(auditLog)).map((a) => a.kind);

describe("jornadas e saúde", () => {
  it("jornada fica em alert se qualquer alerta de qualquer aplicação dela estiver em alert", async () => {
    await ingestEvent(db, event("web", "1", "recovered"));
    await ingestEvent(db, event("pay", "1", "recovered"));
    await ingestEvent(db, event("pay", "2", "triggered"));
    await ingestEvent(db, event("search", "1", "recovered"));
    await createJourney(db, make({ name: "Compra", applications: ["web", "pay"] }), "ana");
    await createJourney(db, make({ name: "Descoberta", applications: ["web", "search"] }), "ana");
    const map = await getJourneyMap(db);
    const byName = Object.fromEntries(map.journeys.map((j) => [j.name, j]));
    expect(byName.Compra.status).toBe("alert");
    expect(byName.Descoberta.status).toBe("ok");
    expect(byName.Compra.counts).toMatchObject({ alert: 1, ok: 2 });
    expect(byName.Compra.total).toBe(3);
  });

  it("aplicação em duas jornadas aparece nas duas e propaga o estado a ambas", async () => {
    await ingestEvent(db, event("web", "2", "triggered"));
    const map = await getJourneyMap(db);
    for (const name of ["Compra", "Descoberta"]) {
      const j = map.journeys.find((x) => x.name === name)!;
      expect(j.applications.map((a) => a.name)).toContain("web");
      expect(j.status).toBe("alert");
    }
  });

  it("ordena da mais grave para a mais saudável e lista as aplicações sem jornada", async () => {
    await ingestEvent(db, event("orfa", "1", "warned"));
    const map = await getJourneyMap(db);
    expect(map.journeys[0].status).toBe("alert");
    expect(map.unassigned.map((a) => a.name)).toEqual(["orfa"]);
    expect(map.totalApplications).toBe(4);
    const compra = map.journeys.find((j) => j.name === "Compra")!;
    expect(compra.applications[0].status).toBe("alert");
  });

  it("jornada vazia ou sem alertas não tem estado", async () => {
    await createJourney(db, make({ name: "Vazia" }), "ana");
    await createJourney(db, make({ name: "SemAlertas", applications: ["sem-alertas"] }), "ana");
    const map = await getJourneyMap(db);
    expect(map.journeys.find((j) => j.name === "Vazia")).toMatchObject({ status: null, total: 0, applications: [] });
    expect(map.journeys.find((j) => j.name === "SemAlertas")?.status).toBeNull();
    expect(await listApplicationNames(db)).toContain("sem-alertas");
  });
});

describe("gestão de jornadas", () => {
  it("rejeita nome repetido e audita a criação com as aplicações", async () => {
    await expect(createJourney(db, make({ name: "Compra" }), "ana")).rejects.toBeInstanceOf(ConflictError);
    const created = await createJourney(db, make({ name: "Nova", description: "d", applications: ["web", "web", "x1"] }), "bia");
    expect(created.applications).toEqual(["web", "x1"]);
    const rows = (await db.select().from(auditLog)).filter((a) => a.kind === "journey_created" && a.actor === "bia");
    expect(rows[0].details).toMatchObject({ name: "Nova", applications: ["web", "x1"] });
  });

  it("troca as aplicações registrando antes e depois; sem mudança não audita", async () => {
    const j = await createJourney(db, make({ name: "Troca", applications: ["a1", "a2"] }), "ana");
    expect(await setJourneyApplications(db, j.id, ["a2", "a3"], "bia")).toEqual(["a2", "a3"]);
    const before = (await auditKinds()).filter((k) => k === "journey_applications_updated").length;
    await setJourneyApplications(db, j.id, ["a3", "a2"], "bia");
    expect((await auditKinds()).filter((k) => k === "journey_applications_updated").length).toBe(before);
    const entry = (await db.select().from(auditLog)).filter((a) => a.kind === "journey_applications_updated").pop();
    expect(entry?.details).toMatchObject({ from: ["a1", "a2"], to: ["a2", "a3"] });
    await expect(setJourneyApplications(db, 999999, [], "bia")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("edita nome e descrição com auditoria e impede nome duplicado", async () => {
    const j = await createJourney(db, make({ name: "Editar" }), "ana");
    const updated = await updateJourney(db, j.id, { name: "Editada", description: "nova" }, "bia");
    expect(updated).toMatchObject({ name: "Editada", description: "nova" });
    const same = await updateJourney(db, j.id, { name: "Editada" }, "bia");
    expect(same.name).toBe("Editada");
    await expect(updateJourney(db, j.id, { name: "Compra" }, "bia")).rejects.toBeInstanceOf(ConflictError);
    await expect(updateJourney(db, 999999, { name: "x" }, "bia")).rejects.toBeInstanceOf(NotFoundError);
    const entry = (await db.select().from(auditLog)).filter((a) => a.kind === "journey_updated").pop();
    expect(entry?.details).toMatchObject({ changes: { name: { from: "Editar", to: "Editada" } } });
  });

  it("remove a jornada preservando aplicações e histórico", async () => {
    const j = await createJourney(db, make({ name: "Remover", applications: ["web"] }), "ana");
    await deleteJourney(db, j.id, "bia");
    expect((await getJourneyMap(db)).journeys.find((x) => x.name === "Remover")).toBeUndefined();
    expect(await listApplicationNames(db)).toContain("web");
    const entry = (await db.select().from(auditLog).where(eq(auditLog.kind, "journey_deleted"))).pop();
    expect(entry?.details).toMatchObject({ name: "Remover", applications: ["web"] });
    await expect(deleteJourney(db, j.id, "bia")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("consultas com jornadas", () => {
  it("detalhe da jornada lista primeiro os alertas mais graves; ausente retorna null", async () => {
    const compra = (await getJourneyMap(db)).journeys.find((j) => j.name === "Compra")!;
    const detail = await getJourneyDetail(db, compra.id);
    expect(detail?.alerts[0].state).toBe("alert");
    expect(detail?.alerts.every((a) => ["web", "pay"].includes(a.application))).toBe(true);
    expect(await getJourneyDetail(db, 999999)).toBeNull();
    const empty = (await getJourneyMap(db)).journeys.find((j) => j.name === "Vazia")!;
    expect((await getJourneyDetail(db, empty.id))?.alerts).toEqual([]);
  });

  it("aplicação e alerta informam as jornadas a que pertencem", async () => {
    const app = await getApplicationDetail(db, "web");
    expect(app?.journeys.map((j) => j.name)).toEqual(expect.arrayContaining(["Compra", "Descoberta"]));
    expect(await getApplicationDetail(db, "nao-existe")).toBeNull();
    const [web] = await db.select().from(alerts).limit(1);
    const detail = await getAlertDetail(db, web.id);
    expect(detail?.journeys.length).toBeGreaterThan(0);
  });
});
