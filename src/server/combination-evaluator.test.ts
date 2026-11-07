import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { alerts, applications, auditLog, combinationAlerts, combinationEvaluatorHeartbeat, combinations } from "@/db/schema";
import type { AlertState } from "@/domain/alert-machine";
import { createTestDb } from "@/test/db";
import { addAutomation, combinationAutomationSchema } from "./combination-automations";
import { evaluateCombinations, recordEvaluatorRun } from "./combination-evaluator";
import type { Db } from "./db-types";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const T0 = new Date("2026-01-01T10:00:00Z");
const after = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
let n = 0;

type Spec = { rule?: "and" | "or" | "at_least"; minCount?: number; durationSeconds?: number; states: AlertState[]; archived?: boolean };

async function setup(spec: Spec) {
  const suffix = ++n;
  const [app] = await db.insert(applications).values({ name: `app-${suffix}` }).returning({ id: applications.id });
  const [combo] = await db
    .insert(combinations)
    .values({
      name: `combo-${suffix}`,
      rule: spec.rule ?? "and",
      minCount: spec.minCount ?? null,
      durationSeconds: spec.durationSeconds ?? 0,
      archivedAt: spec.archived ? T0 : null,
    })
    .returning();
  const alertIds: number[] = [];
  for (const [i, state] of spec.states.entries()) {
    const [alert] = await db
      .insert(alerts)
      .values({ applicationId: app.id, provider: "datadog", externalId: `e-${suffix}-${i}`, name: `A${i}`, state })
      .returning({ id: alerts.id });
    alertIds.push(alert.id);
    await db.insert(combinationAlerts).values({ combinationId: combo.id, alertId: alert.id });
  }
  return { combo, alertIds };
}
const setState = (alertId: number, state: AlertState) => db.update(alerts).set({ state }).where(eq(alerts.id, alertId));
const stateOf = async (id: number) => (await db.select().from(combinations).where(eq(combinations.id, id)))[0];
const transitions = (id: number) =>
  db.select().from(auditLog).where(and(eq(auditLog.combinationId, id), eq(auditLog.kind, "combination_state_changed")));
const automation = (combinationId: number, over: Record<string, unknown> = {}) =>
  addAutomation(db, combinationId, combinationAutomationSchema.parse({ name: "a", mode: "webhook", url: "http://hooks.test/x", ...over }), "t");

describe("regras", () => {
  it("E só dispara com todos em alert; com duração 0 vai direto para alert e devolve a automação", async () => {
    const { combo, alertIds } = await setup({ states: ["alert", "ok"] });
    await automation(combo.id);
    expect((await evaluateCombinations(db, { combinationIds: [combo.id], now: T0 })).changed).toBe(0);
    expect((await stateOf(combo.id)).state).toBe("ok");

    await setState(alertIds[1], "alert");
    const result = await evaluateCombinations(db, { combinationIds: [combo.id], now: after(10) });
    expect(result).toMatchObject({ evaluated: 1, changed: 1 });
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]).toMatchObject({ combinationId: combo.id, state: "alert", previousState: "ok" });
    expect(await stateOf(combo.id)).toMatchObject({ state: "alert", stateChangedAt: after(10) });
    const [entry] = await transitions(combo.id);
    expect(entry.actor).toBe("system:combination");
    expect(entry.details).toMatchObject({ from: "ok", to: "alert", alerting: alertIds });
  });

  it("OU dispara com um alerta", async () => {
    const { combo } = await setup({ rule: "or", states: ["alert", "ok", "warn"] });
    await evaluateCombinations(db, { combinationIds: [combo.id], now: T0 });
    expect((await stateOf(combo.id)).state).toBe("alert");
  });

  it("PELO MENOS N: 1 de 3 não basta, 2 de 3 sim", async () => {
    const { combo, alertIds } = await setup({ rule: "at_least", minCount: 2, states: ["alert", "ok", "no_data"] });
    await evaluateCombinations(db, { combinationIds: [combo.id], now: T0 });
    expect((await stateOf(combo.id)).state).toBe("ok");
    await setState(alertIds[1], "alert");
    await evaluateCombinations(db, { combinationIds: [combo.id], now: after(5) });
    expect((await stateOf(combo.id)).state).toBe("alert");
  });

  it("warn e no_data não contam como alertando", async () => {
    const { combo } = await setup({ rule: "or", states: ["warn", "no_data"] });
    await evaluateCombinations(db, { combinationIds: [combo.id], now: T0 });
    expect((await stateOf(combo.id)).state).toBe("ok");
  });
});

describe("duração", () => {
  it("fica pending até cumprir a duração e então vira alert com a automação", async () => {
    const { combo } = await setup({ states: ["alert", "alert"], durationSeconds: 120 });
    await automation(combo.id);
    const first = await evaluateCombinations(db, { combinationIds: [combo.id], now: T0 });
    expect(first.pending).toHaveLength(0);
    expect(await stateOf(combo.id)).toMatchObject({ state: "pending", satisfiedSince: T0 });

    const early = await evaluateCombinations(db, { combinationIds: [combo.id], now: after(119) });
    expect(early.changed).toBe(0);
    expect((await stateOf(combo.id)).state).toBe("pending");

    const done = await evaluateCombinations(db, { combinationIds: [combo.id], now: after(120) });
    expect(done.pending).toHaveLength(1);
    expect(await stateOf(combo.id)).toMatchObject({ state: "alert", satisfiedSince: T0 });
    expect(await transitions(combo.id)).toHaveLength(2);
  });

  it("um alerta que cai antes da duração zera a contagem; ao voltar, recomeça", async () => {
    const { combo, alertIds } = await setup({ states: ["alert", "alert"], durationSeconds: 120 });
    await automation(combo.id);
    await evaluateCombinations(db, { combinationIds: [combo.id], now: T0 });
    await setState(alertIds[0], "ok");
    const drop = await evaluateCombinations(db, { combinationIds: [combo.id], now: after(60) });
    expect(drop.pending).toHaveLength(0);
    expect(await stateOf(combo.id)).toMatchObject({ state: "ok", satisfiedSince: null });

    await setState(alertIds[0], "alert");
    await evaluateCombinations(db, { combinationIds: [combo.id], now: after(100) });
    expect(await stateOf(combo.id)).toMatchObject({ state: "pending", satisfiedSince: after(100) });
    const notYet = await evaluateCombinations(db, { combinationIds: [combo.id], now: after(219) });
    expect(notYet.pending).toHaveLength(0);
    const done = await evaluateCombinations(db, { combinationIds: [combo.id], now: after(220) });
    expect(done.pending).toHaveLength(1);
  });

  it("uma combinação de um alerta com duração também passa por pending", async () => {
    const { combo } = await setup({ states: ["alert"], durationSeconds: 300 });
    await evaluateCombinations(db, { combinationIds: [combo.id], now: T0 });
    expect((await stateOf(combo.id)).state).toBe("pending");
    await evaluateCombinations(db, { combinationIds: [combo.id], now: after(300) });
    expect((await stateOf(combo.id)).state).toBe("alert");
  });
});

describe("normalização", () => {
  it("a volta de alert para ok devolve só as automações com gatilho ok", async () => {
    const { combo, alertIds } = await setup({ states: ["alert"] });
    await automation(combo.id, { name: "só alerta" });
    const both = await automation(combo.id, { name: "ambos", triggerStates: ["alert", "ok"] });
    expect((await evaluateCombinations(db, { combinationIds: [combo.id], now: T0 })).pending).toHaveLength(2);

    await setState(alertIds[0], "ok");
    const back = await evaluateCombinations(db, { combinationIds: [combo.id], now: after(30) });
    expect(back.pending.map((p) => p.automation.id)).toEqual([both.id]);
    expect(back.pending[0]).toMatchObject({ state: "ok", previousState: "alert" });
    expect(await stateOf(combo.id)).toMatchObject({ state: "ok", satisfiedSince: null });
  });

  it("a volta de pending para ok não dispara automação", async () => {
    const { combo, alertIds } = await setup({ states: ["alert"], durationSeconds: 60 });
    await automation(combo.id, { triggerStates: ["alert", "ok"] });
    await evaluateCombinations(db, { combinationIds: [combo.id], now: T0 });
    await setState(alertIds[0], "ok");
    const back = await evaluateCombinations(db, { combinationIds: [combo.id], now: after(10) });
    expect(back).toMatchObject({ changed: 1, pending: [] });
  });
});

describe("silenciado e arquivado", () => {
  it("silenciado não conta; sem nenhum evento, o fim do silêncio passa a contar", async () => {
    const { combo, alertIds } = await setup({ states: ["alert"] });
    await db.update(alerts).set({ mutedUntil: after(60) }).where(eq(alerts.id, alertIds[0]));
    await evaluateCombinations(db, { combinationIds: [combo.id], now: T0 });
    expect((await stateOf(combo.id)).state).toBe("ok");
    await evaluateCombinations(db, { combinationIds: [combo.id], now: after(120) });
    expect((await stateOf(combo.id)).state).toBe("alert");
  });

  it("alerta arquivado não conta e com E a combinação não consegue disparar", async () => {
    const { combo, alertIds } = await setup({ states: ["alert", "alert"] });
    await db.update(alerts).set({ archivedAt: T0 }).where(eq(alerts.id, alertIds[1]));
    await evaluateCombinations(db, { combinationIds: [combo.id], now: T0 });
    expect((await stateOf(combo.id)).state).toBe("ok");
  });
});

describe("escopo", () => {
  it("combinação arquivada nunca é avaliada", async () => {
    const { combo } = await setup({ states: ["alert"], archived: true });
    const result = await evaluateCombinations(db, { combinationIds: [combo.id], now: T0 });
    expect(result).toMatchObject({ evaluated: 0, changed: 0 });
    expect((await stateOf(combo.id)).state).toBe("ok");
  });

  it("alertId avalia só as combinações que contêm o alerta", async () => {
    const a = await setup({ states: ["alert"] });
    const b = await setup({ states: ["alert"] });
    const result = await evaluateCombinations(db, { alertId: a.alertIds[0], now: T0 });
    expect(result.evaluated).toBe(1);
    expect((await stateOf(a.combo.id)).state).toBe("alert");
    expect((await stateOf(b.combo.id)).state).toBe("ok");
  });

  it("sem filtros avalia todas as não arquivadas", async () => {
    const c = await setup({ states: ["alert"] });
    const result = await evaluateCombinations(db, { now: T0 });
    expect(result.evaluated).toBeGreaterThanOrEqual(1);
    expect((await stateOf(c.combo.id)).state).toBe("alert");
  });
});

describe("concorrência", () => {
  it("duas avaliações ao mesmo tempo geram uma transição, uma auditoria e uma automação", async () => {
    const { combo } = await setup({ states: ["alert"] });
    await automation(combo.id);
    const results = await Promise.all([
      evaluateCombinations(db, { combinationIds: [combo.id], now: T0 }),
      evaluateCombinations(db, { combinationIds: [combo.id], now: T0 }),
    ]);
    expect(results.flatMap((r) => r.pending)).toHaveLength(1);
    expect(results.reduce((sum, r) => sum + r.changed, 0)).toBe(1);
    expect(await transitions(combo.id)).toHaveLength(1);
  });
});

describe("recordEvaluatorRun", () => {
  it("cria e depois atualiza a mesma linha", async () => {
    await recordEvaluatorRun(db, T0);
    await recordEvaluatorRun(db, after(30));
    const rows = await db.select().from(combinationEvaluatorHeartbeat);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, lastRunAt: after(30) });
  });
});
