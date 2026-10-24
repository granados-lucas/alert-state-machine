import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { alerts, auditLog, remediations, webhookEvents } from "@/db/schema";
import type { NormalizedEvent } from "@/providers/types";
import { createTestDb } from "@/test/db";
import type { Db } from "./db-types";
import { ingestEvent } from "./ingest";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

let seq = 0;
const T0 = Date.parse("2026-01-01T00:00:00Z");
function ev(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  seq += 1;
  return {
    provider: "datadog",
    externalEventId: `evt-${seq}`,
    externalAlertId: "mon-1",
    alertName: "CPU alta",
    application: "checkout",
    event: "triggered",
    occurredAt: new Date(T0 + seq * 1000),
    priority: 2,
    tags: ["service:checkout"],
    link: null,
    raw: { n: seq },
    ...overrides,
  };
}
const audit = (alertId: number) => db.select().from(auditLog).where(eq(auditLog.alertId, alertId)).orderBy(auditLog.id);

describe("ingestEvent", () => {
  it("descobre o alerta, aplica a transição e audita criação e mudança de estado", async () => {
    const r = await ingestEvent(db, ev({ externalAlertId: "disc-1" }));
    if (r.status !== "processed") throw new Error("esperava processed");
    expect(r).toMatchObject({ outcome: "applied", from: "no_data", to: "alert" });
    const rows = await audit(r.alertId);
    expect(rows.map((a) => a.kind)).toEqual(["alert_created", "state_changed"]);
    expect(rows[1]).toMatchObject({ fromState: "no_data", toState: "alert", actor: "system:datadog" });
  });

  it("é idempotente: o mesmo evento não gera segunda transição", async () => {
    const event = ev({ externalAlertId: "idem-1" });
    const first = await ingestEvent(db, event);
    const second = await ingestEvent(db, event);
    expect(second).toEqual({ status: "duplicate" });
    if (first.status !== "processed") throw new Error();
    const changes = (await audit(first.alertId)).filter((a) => a.kind === "state_changed");
    expect(changes).toHaveLength(1);
  });

  it("registra evento que repete o estado como unchanged, sem nova transição", async () => {
    const a = await ingestEvent(db, ev({ externalAlertId: "same-1" }));
    const b = await ingestEvent(db, ev({ externalAlertId: "same-1" }));
    expect(b).toMatchObject({ status: "processed", outcome: "unchanged", to: "alert" });
    if (a.status !== "processed") throw new Error();
    expect((await audit(a.alertId)).filter((x) => x.kind === "state_changed")).toHaveLength(1);
  });

  it("descarta evento fora de ordem (stale) sem alterar o estado", async () => {
    const newer = ev({ externalAlertId: "stale-1", event: "recovered", occurredAt: new Date(T0 + 900_000) });
    const older = ev({ externalAlertId: "stale-1", event: "triggered", occurredAt: new Date(T0 + 100_000) });
    await ingestEvent(db, newer);
    const r = await ingestEvent(db, older);
    expect(r).toMatchObject({ status: "processed", outcome: "stale", to: "ok" });
    const [row] = await db.select().from(alerts).where(eq(alerts.externalId, "stale-1"));
    expect(row.state).toBe("ok");
  });

  it("registra como ignored o evento sem efeito na máquina", async () => {
    const r = await ingestEvent(db, ev({ externalAlertId: "ign-1", event: null }));
    expect(r).toMatchObject({ outcome: "ignored", to: "no_data" });
    const [stored] = await db.select().from(webhookEvents).where(eq(webhookEvents.alertId, (r as { alertId: number }).alertId));
    expect(stored.outcome).toBe("ignored");
  });

  it("ignora eventos de alerta arquivado e mantém o estado", async () => {
    const created = await ingestEvent(db, ev({ externalAlertId: "arch-1" }));
    if (created.status !== "processed") throw new Error();
    await db.update(alerts).set({ archivedAt: new Date() }).where(eq(alerts.id, created.alertId));
    const r = await ingestEvent(db, ev({ externalAlertId: "arch-1", event: "recovered" }));
    expect(r).toMatchObject({ outcome: "ignored", to: "alert" });
  });

  it("move o alerta quando a aplicação muda e registra na auditoria", async () => {
    const a = await ingestEvent(db, ev({ externalAlertId: "move-1", application: "old-app" }));
    await ingestEvent(db, ev({ externalAlertId: "move-1", application: "new-app", event: "warned" }));
    if (a.status !== "processed") throw new Error();
    expect((await audit(a.alertId)).map((x) => x.kind)).toContain("alert_updated");
  });

  it("serializa eventos concorrentes do mesmo alerta sem perder nem duplicar transições", async () => {
    const events = [ev({ externalAlertId: "race-1", event: "warned" }), ev({ externalAlertId: "race-1", event: "triggered" })];
    const results = await Promise.all(events.map((e) => ingestEvent(db, e)));
    expect(results.every((r) => r.status === "processed")).toBe(true);
    const [row] = await db.select().from(alerts).where(eq(alerts.externalId, "race-1"));
    const changes = (await audit(row.id)).filter((x) => x.kind === "state_changed");
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(row.state).toBe(changes[changes.length - 1].toState);
  });

  it("devolve as remediações ativas que reagem ao novo estado", async () => {
    const first = await ingestEvent(db, ev({ externalAlertId: "rem-1", event: "recovered" }));
    if (first.status !== "processed") throw new Error();
    await db.insert(remediations).values([
      { alertId: first.alertId, name: "restart", mode: "webhook", url: "http://x.test/a", triggerStates: ["alert"] },
      { alertId: first.alertId, name: "off", mode: "webhook", url: "http://x.test/b", triggerStates: ["alert"], enabled: false },
      { alertId: first.alertId, name: "other", mode: "webhook", url: "http://x.test/c", triggerStates: ["warn"] },
    ]);
    const r = await ingestEvent(db, ev({ externalAlertId: "rem-1", event: "triggered" }));
    if (r.status !== "processed") throw new Error();
    expect(r.pending.map((p) => p.remediation.name)).toEqual(["restart"]);
    expect(r.pending[0]).toMatchObject({ state: "alert", previousState: "ok" });
  });

  it("impede alterar ou apagar a auditoria (trigger)", async () => {
    const [row] = await db.select().from(auditLog).limit(1);
    await expect(db.update(auditLog).set({ actor: "x" }).where(eq(auditLog.id, row.id))).rejects.toThrow();
    await expect(db.delete(auditLog).where(eq(auditLog.id, row.id))).rejects.toThrow();
  });
});
