import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, remediations } from "@/db/schema";
import { createTestDb } from "@/test/db";
import { addRemediation, createAlert, createAlertSchema, updateAlert, updateRemediation } from "./alerts";
import type { Db } from "./db-types";
import { ConflictError, NotFoundError } from "./errors";
import { ingestEvent } from "./ingest";
import { remediationInputSchema } from "./remediation";
import { getAlertDetail, getApplicationMap, getRecentChanges, listAlerts } from "./queries";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const input = (over: Record<string, unknown> = {}) =>
  createAlertSchema.parse({ externalId: "m-1", name: "Latência", application: "checkout", ...over });
const hook = remediationInputSchema.parse({ name: "restart", mode: "webhook", url: "http://hooks.test/fix" });

describe("createAlert", () => {
  it("cria alerta com remediação e audita criação e remediação", async () => {
    const alert = await createAlert(db, input({ remediations: [hook], priority: 1 }), "ana");
    expect(alert).toMatchObject({ state: "no_data", priority: 1, provider: "datadog" });
    const rows = await db.select().from(auditLog).where(eq(auditLog.alertId, alert.id)).orderBy(auditLog.id);
    expect(rows.map((r) => [r.kind, r.actor])).toEqual([["alert_created", "ana"], ["remediation_created", "ana"]]);
    expect(await db.select().from(remediations).where(eq(remediations.alertId, alert.id))).toHaveLength(1);
  });

  it("rejeita duplicata do mesmo provedor e id externo", async () => {
    await expect(createAlert(db, input(), "ana")).rejects.toBeInstanceOf(ConflictError);
  });

  it("valida a entrada", () => {
    expect(() => createAlertSchema.parse({ externalId: "", name: "x", application: "a" })).toThrow();
    expect(() => createAlertSchema.parse({ externalId: "1", name: "x", application: "a", link: "javascript:alert(1)" })).toThrow();
  });
});

describe("updateAlert", () => {
  it("registra antes/depois e ignora atualizações sem mudança", async () => {
    const alert = await createAlert(db, input({ externalId: "u-1" }), "ana");
    const updated = await updateAlert(db, alert.id, { name: "Novo nome", priority: 3 }, "bia");
    expect(updated.name).toBe("Novo nome");
    const same = await updateAlert(db, alert.id, { name: "Novo nome" }, "bia");
    expect(same.updatedAt).toEqual(updated.updatedAt);
    const rows = await db.select().from(auditLog).where(eq(auditLog.alertId, alert.id)).orderBy(auditLog.id);
    expect(rows.filter((r) => r.kind === "alert_updated")).toHaveLength(1);
    expect(rows[1].details).toMatchObject({ changes: { name: { from: "Latência", to: "Novo nome" }, priority: { from: null, to: 3 } } });
  });

  it("arquiva e desarquiva, retirando o alerta do mapa", async () => {
    const alert = await createAlert(db, input({ externalId: "a-1", application: "solo" }), "ana");
    expect((await getApplicationMap(db)).applications.find((a) => a.name === "solo")?.total).toBe(1);
    await updateAlert(db, alert.id, { archived: true }, "ana");
    expect((await getApplicationMap(db)).applications.find((a) => a.name === "solo")?.total).toBe(0);
    expect((await listAlerts(db, { application: "solo" })).items).toHaveLength(0);
    await updateAlert(db, alert.id, { archived: false }, "ana");
    expect((await listAlerts(db, { application: "solo" })).items).toHaveLength(1);
    const kinds = (await db.select().from(auditLog).where(eq(auditLog.alertId, alert.id))).map((r) => r.kind);
    expect(kinds.filter((k) => k === "alert_archived")).toHaveLength(2);
  });

  it("falha com NotFoundError para alerta inexistente", async () => {
    await expect(updateAlert(db, 999999, { name: "x" }, "ana")).rejects.toBeInstanceOf(NotFoundError);
    await expect(addRemediation(db, 999999, hook, "ana")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("remediações", () => {
  it("adiciona, desativa e registra a diferença; sem mudança não audita", async () => {
    const alert = await createAlert(db, input({ externalId: "r-1" }), "ana");
    const rem = await addRemediation(db, alert.id, hook, "ana");
    const off = await updateRemediation(db, alert.id, rem.id, { enabled: false }, "bia");
    expect(off.enabled).toBe(false);
    await updateRemediation(db, alert.id, rem.id, { enabled: false }, "bia");
    const rows = await db.select().from(auditLog).where(eq(auditLog.alertId, alert.id));
    expect(rows.filter((r) => r.kind === "remediation_updated")).toHaveLength(1);
    await expect(updateRemediation(db, alert.id, 424242, { enabled: true }, "bia")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("queries", () => {
  it("mapa: aplicação fica em alert se qualquer alerta estiver em alert", async () => {
    const e = (id: string, event: "triggered" | "recovered") => ({
      provider: "datadog", externalEventId: `${id}-${event}`, externalAlertId: id, alertName: id, application: "mapa-app",
      event, occurredAt: new Date(), priority: null, tags: [], link: null, raw: {},
    });
    await ingestEvent(db, e("x1", "recovered"));
    await ingestEvent(db, e("x2", "recovered"));
    await ingestEvent(db, e("x3", "triggered"));
    const app = (await getApplicationMap(db)).applications.find((a) => a.name === "mapa-app");
    expect(app).toMatchObject({ status: "alert", total: 3, counts: { ok: 2, alert: 1, warn: 0, no_data: 0 } });
  });

  it("lista com filtros e paginação por cursor", async () => {
    for (let i = 0; i < 5; i++) await createAlert(db, input({ externalId: `p-${i}`, name: `Paginado ${i}`, application: "pag" }), "ana");
    const first = await listAlerts(db, { application: "pag", limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listAlerts(db, { application: "pag", limit: 2, before: first.nextCursor! });
    expect(second.items[0].id).toBeLessThan(first.items[1].id);
    expect((await listAlerts(db, { search: "paginado 3" })).items).toHaveLength(1);
    expect((await listAlerts(db, { search: "100%_" })).items).toHaveLength(0);
    expect((await listAlerts(db, { state: "alert", application: "pag" })).items).toHaveLength(0);
  });

  it("detalhe do alerta traz remediações, execuções e auditoria; ausente retorna null", async () => {
    const alert = await createAlert(db, input({ externalId: "d-1", remediations: [hook] }), "ana");
    const detail = await getAlertDetail(db, alert.id);
    expect(detail?.remediations).toHaveLength(1);
    expect(detail?.audit.length).toBeGreaterThanOrEqual(2);
    expect(detail?.runs).toEqual([]);
    expect(await getAlertDetail(db, 999999)).toBeNull();
  });

  it("mudanças recentes: mais novas primeiro, só mudanças de estado, com limite", async () => {
    const e = (id: string, event: "triggered" | "recovered") => ({
      provider: "datadog", externalEventId: `rc-${id}-${event}`, externalAlertId: `rc-${id}`, alertName: `Recente ${id}`, application: "recentes",
      event, occurredAt: new Date(), priority: null, tags: [], link: null, raw: {},
    });
    await ingestEvent(db, e("a", "triggered"));
    await ingestEvent(db, e("b", "recovered"));
    const recent = await getRecentChanges(db, 2);
    expect(recent).toHaveLength(2);
    expect(recent[0]).toMatchObject({ alertName: "Recente b", fromState: "no_data", toState: "ok", application: "recentes" });
    expect(recent[1]).toMatchObject({ alertName: "Recente a", toState: "alert" });
    expect((await getRecentChanges(db)).every((r) => r.toState !== null)).toBe(true);
  });
});
