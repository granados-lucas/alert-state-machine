import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { alerts, applications, auditLog, combinationAlerts, combinations } from "@/db/schema";
import type { AlertState } from "@/domain/alert-machine";
import { createTestDb } from "@/test/db";
import { createCombination, createCombinationSchema, updateCombination, updateCombinationSchema } from "./combinations";
import { getCombination, listCombinations } from "./combination-queries";
import { addAutomation, combinationAutomationSchema } from "./combination-automations";
import type { Db } from "./db-types";
import { ConflictError, NotFoundError, ValidationError } from "./errors";

let db: Db;
let close: () => Promise<void>;
let appId: number;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  [{ id: appId }] = await db.insert(applications).values({ name: "app" }).returning({ id: applications.id });
});
afterAll(() => close());

let n = 0;
const newAlert = async (state: AlertState = "ok", over: Partial<typeof alerts.$inferInsert> = {}) => {
  const [alert] = await db
    .insert(alerts)
    .values({ applicationId: appId, provider: "datadog", externalId: `x-${++n}`, name: `Alerta ${n}`, state, ...over })
    .returning({ id: alerts.id });
  return alert.id;
};
const input = (alertIds: number[], over: Record<string, unknown> = {}) =>
  createCombinationSchema.parse({ name: `Combinação ${++n}`, rule: "and", alertIds, ...over });
const links = async (id: number) =>
  (await db.select({ alertId: combinationAlerts.alertId }).from(combinationAlerts).where(eq(combinationAlerts.combinationId, id))).map((r) => r.alertId).sort((a, b) => a - b);
const audit = (id: number, kind: "combination_created" | "combination_updated" | "combination_archived") =>
  db.select().from(auditLog).where(and(eq(auditLog.combinationId, id), eq(auditLog.kind, kind)));

describe("schemas", () => {
  const base = { name: "c", rule: "and", alertIds: [1, 2] };
  it("aplica padrões", () => {
    expect(createCombinationSchema.parse(base)).toMatchObject({ durationSeconds: 0, automations: [] });
  });
  it("at_least exige minCount dentro de 1..alertIds; and/or o proíbem", () => {
    expect(() => createCombinationSchema.parse({ ...base, rule: "at_least" })).toThrow();
    expect(() => createCombinationSchema.parse({ ...base, rule: "at_least", minCount: 3 })).toThrow();
    expect(createCombinationSchema.parse({ ...base, rule: "at_least", minCount: 2 }).minCount).toBe(2);
    expect(() => createCombinationSchema.parse({ ...base, minCount: 1 })).toThrow();
    expect(() => createCombinationSchema.parse({ ...base, rule: "or", minCount: 1 })).toThrow();
  });
  it("limita componentes (1..20), duração e rejeita repetidos", () => {
    expect(() => createCombinationSchema.parse({ ...base, alertIds: [] })).toThrow();
    expect(() => createCombinationSchema.parse({ ...base, alertIds: Array.from({ length: 21 }, (_, i) => i + 1) })).toThrow();
    expect(() => createCombinationSchema.parse({ ...base, alertIds: [1, 1] })).toThrow();
    expect(() => createCombinationSchema.parse({ ...base, durationSeconds: 86_401 })).toThrow();
  });
  it("a atualização é parcial, sem padrões, e não aceita corpo vazio", () => {
    expect(() => updateCombinationSchema.parse({})).toThrow();
    expect(updateCombinationSchema.parse({ name: "novo" })).toEqual({ name: "novo" });
  });
});

describe("createCombination", () => {
  it("grava tudo e a avaliação imediata devolve a automação quando a regra já vale", async () => {
    const a = await newAlert("alert");
    const b = await newAlert("alert");
    const { combination, pending } = await createCombination(
      db,
      input([a, b], { description: "causa e consequência", automations: [{ name: "r", mode: "webhook", url: "http://hooks.test/x" }] }),
      "ana",
    );
    expect(combination).toMatchObject({ state: "alert", rule: "and", durationSeconds: 0, description: "causa e consequência" });
    expect(await links(combination.id)).toEqual([a, b]);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ combinationId: combination.id, state: "alert", previousState: "ok" });
    const [created] = await audit(combination.id, "combination_created");
    expect(created).toMatchObject({ actor: "ana", details: { rule: "and", alertIds: [a, b], automations: 1 } });
    const all = await db.select().from(auditLog).where(and(eq(auditLog.combinationId, combination.id), eq(auditLog.kind, "combination_automation_created")));
    expect(all).toHaveLength(1);
  });

  it("com duração fica pending e sem automação pendente", async () => {
    const a = await newAlert("alert");
    const { combination, pending } = await createCombination(db, input([a], { durationSeconds: 300 }), "ana");
    expect(combination.state).toBe("pending");
    expect(pending).toEqual([]);
  });

  it("nome repetido é ConflictError", async () => {
    const a = await newAlert();
    const first = input([a]);
    await createCombination(db, first, "ana");
    await expect(createCombination(db, input([a], { name: first.name }), "ana")).rejects.toBeInstanceOf(ConflictError);
  });

  it("alerta inexistente ou arquivado é ValidationError e nada fica gravado", async () => {
    const a = await newAlert();
    const archived = await newAlert("ok", { archivedAt: new Date() });
    const bad = input([a, archived]);
    await expect(createCombination(db, bad, "ana")).rejects.toBeInstanceOf(ValidationError);
    await expect(createCombination(db, input([a, 999_999]), "ana")).rejects.toBeInstanceOf(ValidationError);
    expect(await db.select().from(combinations).where(eq(combinations.name, bad.name))).toHaveLength(0);
  });
});

describe("updateCombination", () => {
  const make = async (over: Record<string, unknown> = {}, states: AlertState[] = ["ok", "ok", "ok"]) => {
    const ids = await Promise.all(states.map((s) => newAlert(s)));
    const { combination } = await createCombination(db, input(ids, over), "ana");
    return { combination, ids };
  };

  it("sem mudança real não grava auditoria", async () => {
    const { combination } = await make();
    await updateCombination(db, combination.id, { name: combination.name, durationSeconds: 0 }, "ana");
    expect(await audit(combination.id, "combination_updated")).toHaveLength(0);
  });

  it("grava antes e depois, incluindo a lista de alertas, e reavalia", async () => {
    const { combination, ids } = await make({ durationSeconds: 120 }, ["alert", "alert", "alert"]);
    expect(combination.state).toBe("pending");
    const { combination: updated, pending } = await updateCombination(db, combination.id, { durationSeconds: 0, alertIds: [ids[0], ids[1]] }, "bia");
    expect(updated.state).toBe("alert");
    expect(pending).toEqual([]);
    expect(await links(combination.id)).toEqual([ids[0], ids[1]]);
    const [entry] = await audit(combination.id, "combination_updated");
    expect(entry).toMatchObject({
      actor: "bia",
      details: { changes: { durationSeconds: { from: 120, to: 0 }, alertIds: { from: ids, to: [ids[0], ids[1]] } } },
    });
  });

  it("at_least é validado contra a lista resultante", async () => {
    const { combination, ids } = await make({ rule: "at_least", minCount: 3 });
    await expect(updateCombination(db, combination.id, { alertIds: [ids[0], ids[1]] }, "ana")).rejects.toBeInstanceOf(ValidationError);
    await expect(updateCombination(db, combination.id, { minCount: 4 }, "ana")).rejects.toBeInstanceOf(ValidationError);
    await updateCombination(db, combination.id, { alertIds: [ids[0], ids[1]], minCount: 2 }, "ana");
    expect(await links(combination.id)).toEqual([ids[0], ids[1]]);
  });

  it("trocar at_least por and exige limpar o minCount no mesmo pedido", async () => {
    const { combination } = await make({ rule: "at_least", minCount: 2 });
    await expect(updateCombination(db, combination.id, { rule: "and" }, "ana")).rejects.toBeInstanceOf(ValidationError);
    const { combination: updated } = await updateCombination(db, combination.id, { rule: "and", minCount: null }, "ana");
    expect(updated).toMatchObject({ rule: "and", minCount: null });
  });

  it("nome repetido, alerta inválido e combinação inexistente", async () => {
    const one = await make();
    const two = await make();
    await expect(updateCombination(db, one.combination.id, { name: two.combination.name }, "ana")).rejects.toBeInstanceOf(ConflictError);
    await expect(updateCombination(db, one.combination.id, { alertIds: [999_999] }, "ana")).rejects.toBeInstanceOf(ValidationError);
    await expect(updateCombination(db, 999_999, { name: "x" }, "ana")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("arquivar tira da listagem, audita e mantém a leitura por id", async () => {
    const { combination } = await make();
    await updateCombination(db, combination.id, { archived: true }, "ana");
    expect(await audit(combination.id, "combination_archived")).toHaveLength(1);
    expect((await listCombinations(db)).map((c) => c.id)).not.toContain(combination.id);
    expect((await listCombinations(db, { includeArchived: true })).map((c) => c.id)).toContain(combination.id);
    expect((await getCombination(db, combination.id))?.archivedAt).not.toBeNull();
  });
});

describe("consultas", () => {
  it("listCombinations ordena alert, pending e ok e descreve os componentes", async () => {
    const now = new Date("2026-01-01T10:00:00Z");
    const okId = await newAlert("ok");
    const alertId = await newAlert("alert");
    const mutedId = await newAlert("alert", { mutedUntil: new Date(now.getTime() + 60_000) });
    const archivedId = await newAlert("alert");
    const mk = (ids: number[], over: Record<string, unknown> = {}) => createCombination(db, input(ids, over), "ana");
    const normal = (await mk([okId], { name: "ordem-normal" })).combination;
    const armando = (await mk([alertId], { name: "ordem-armando", durationSeconds: 600 })).combination;
    const alerta = (await mk([alertId], { name: "ordem-alerta" })).combination;
    const withMuted = (await mk([mutedId, archivedId], { name: "ordem-componentes", rule: "or" })).combination;
    await db.update(alerts).set({ archivedAt: now }).where(eq(alerts.id, archivedId));

    const list = await listCombinations(db, { now });
    const ranks = list.filter((c) => c.name.startsWith("ordem-")).map((c) => c.id);
    expect(ranks.indexOf(alerta.id)).toBeLessThan(ranks.indexOf(armando.id));
    expect(ranks.indexOf(armando.id)).toBeLessThan(ranks.indexOf(normal.id));

    const view = list.find((c) => c.id === withMuted.id)!;
    expect(view.hasArchivedComponent).toBe(true);
    expect(view.alertingCount).toBe(0);
    const byId = new Map(view.components.map((c) => [c.id, c]));
    expect(byId.get(mutedId)).toMatchObject({ muted: true, alerting: false, archived: false });
    expect(byId.get(archivedId)).toMatchObject({ archived: true, alerting: false });
    expect(list.find((c) => c.id === alerta.id)).toMatchObject({ alertingCount: 1 });
  });

  it("getCombination devolve automações, execuções e histórico", async () => {
    const a = await newAlert("alert");
    const { combination } = await createCombination(db, input([a]), "ana");
    await addAutomation(db, combination.id, combinationAutomationSchema.parse({ name: "x", mode: "webhook", url: "http://hooks.test/x" }), "ana");
    const detail = await getCombination(db, combination.id);
    expect(detail).toMatchObject({ id: combination.id, state: "alert" });
    expect(detail?.automations).toHaveLength(1);
    expect(detail?.runs).toEqual([]);
    expect(detail?.audit.map((r) => r.kind)).toEqual(expect.arrayContaining(["combination_created", "combination_state_changed", "combination_automation_created"]));
    expect(await getCombination(db, 999_999)).toBeNull();
  });
});
