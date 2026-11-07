import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { alerts, applications, auditLog, combinationAlerts, combinationAutomationRuns, combinations } from "@/db/schema";
import { createTestDb } from "@/test/db";
import {
  addAutomation,
  combinationAutomationSchema,
  findTriggeredAutomations,
  runAutomations,
  updateAutomation,
  updateAutomationSchema,
  type PendingAutomation,
} from "./combination-automations";
import type { Db } from "./db-types";
import { NotFoundError } from "./errors";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const base = { name: "reiniciar", mode: "webhook" as const, url: "http://hooks.test:9000/fix" };
let n = 0;

async function newCombination(alertStates: ("alert" | "ok")[] = ["alert", "ok"]) {
  const suffix = ++n;
  const [app] = await db.insert(applications).values({ name: `app-${suffix}` }).returning({ id: applications.id });
  const [combo] = await db.insert(combinations).values({ name: `combo-${suffix}`, rule: "and", durationSeconds: 120 }).returning();
  for (const [i, state] of alertStates.entries()) {
    const [alert] = await db
      .insert(alerts)
      .values({ applicationId: app.id, provider: "datadog", externalId: `m-${suffix}-${i}`, name: `Alerta ${i}`, state, priority: 2 })
      .returning({ id: alerts.id });
    await db.insert(combinationAlerts).values({ combinationId: combo.id, alertId: alert.id });
  }
  return combo;
}
const deps = (fetchImpl: typeof fetch, allowedHosts = ["hooks.test"], env: Record<string, string> = {}) => ({ fetch: fetchImpl, allowedHosts, env });
const okResponse = (status = 200) => new Response(null, { status });

describe("combinationAutomationSchema", () => {
  it("aplica padrões e aceita gatilhos alert e ok", () => {
    expect(combinationAutomationSchema.parse(base)).toMatchObject({ method: "POST", triggerStates: ["alert"], timeoutMs: 5000, enabled: true });
    expect(combinationAutomationSchema.parse({ ...base, triggerStates: ["alert", "ok"] }).triggerStates).toEqual(["alert", "ok"]);
  });

  it("rejeita o gatilho pending", () => {
    expect(() => combinationAutomationSchema.parse({ ...base, triggerStates: ["pending"] })).toThrow();
  });

  it("exige env:NOME em cabeçalho sensível e rejeita credenciais na URL", () => {
    expect(() => combinationAutomationSchema.parse({ ...base, mode: "api", headers: { Authorization: "x" } })).toThrow();
    expect(combinationAutomationSchema.parse({ ...base, mode: "api", headers: { Authorization: "env:MEU_TOKEN" } }).headers).toEqual({ Authorization: "env:MEU_TOKEN" });
    expect(() => combinationAutomationSchema.parse({ ...base, url: "http://u:p@hooks.test/x" })).toThrow();
  });

  it("webhook sempre POST e sem modelo de corpo", () => {
    expect(() => combinationAutomationSchema.parse({ ...base, method: "PUT" })).toThrow();
    expect(() => combinationAutomationSchema.parse({ ...base, bodyTemplate: "{}" })).toThrow();
  });
});

describe("addAutomation", () => {
  it("grava a automação e a auditoria", async () => {
    const combo = await newCombination();
    const row = await addAutomation(db, combo.id, combinationAutomationSchema.parse(base), "ana");
    expect(row).toMatchObject({ combinationId: combo.id, name: "reiniciar", enabled: true });
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.combinationId, combo.id), eq(auditLog.kind, "combination_automation_created")));
    expect(entry).toMatchObject({ actor: "ana", details: { automationId: row.id, name: "reiniciar", triggerStates: ["alert"] } });
  });

  it("combinação inexistente é NotFoundError", async () => {
    await expect(addAutomation(db, 999_999, combinationAutomationSchema.parse(base), "ana")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("updateAutomation", () => {
  const setup = async () => {
    const combo = await newCombination();
    const row = await addAutomation(db, combo.id, combinationAutomationSchema.parse(base), "ana");
    return { combo, row };
  };
  const updates = (combinationId: number) =>
    db.select().from(auditLog).where(and(eq(auditLog.combinationId, combinationId), eq(auditLog.kind, "combination_automation_updated")));

  it("sem mudança real não grava auditoria", async () => {
    const { combo, row } = await setup();
    await updateAutomation(db, combo.id, row.id, { name: "reiniciar", enabled: true }, "ana");
    expect(await updates(combo.id)).toHaveLength(0);
  });

  it("troca campos, desativa e audita antes e depois", async () => {
    const { combo, row } = await setup();
    const updated = await updateAutomation(
      db,
      combo.id,
      row.id,
      { name: "novo", url: "http://hooks.test:9000/outro", triggerStates: ["alert", "ok"], timeoutMs: 2000, enabled: false },
      "bia",
    );
    expect(updated).toMatchObject({ name: "novo", url: "http://hooks.test:9000/outro", triggerStates: ["alert", "ok"], timeoutMs: 2000, enabled: false });
    const [entry] = await updates(combo.id);
    expect(entry.actor).toBe("bia");
    expect(entry.details).toMatchObject({
      automationId: row.id,
      changes: { name: { from: "reiniciar", to: "novo" }, enabled: { from: true, to: false }, timeoutMs: { from: 5000, to: 2000 } },
    });
  });

  it("troca método e corpo no modo api e cabeçalhos aparecem só pelos nomes", async () => {
    const { combo, row } = await setup();
    const updated = await updateAutomation(
      db,
      combo.id,
      row.id,
      { mode: "api", method: "PUT", bodyTemplate: '{"n":"{{combination.name}}"}', headers: { Authorization: "env:MEU_TOKEN" } },
      "ana",
    );
    expect(updated).toMatchObject({ mode: "api", method: "PUT", headers: { Authorization: "env:MEU_TOKEN" } });
    const [entry] = await updates(combo.id);
    expect(JSON.stringify(entry.details)).not.toContain("env:MEU_TOKEN");
    expect(entry.details).toMatchObject({ changes: { headers: { from: [], to: ["Authorization"] } } });
  });

  it("rejeita resultado mesclado inválido", async () => {
    const { combo, row } = await setup();
    await expect(updateAutomation(db, combo.id, row.id, { bodyTemplate: "{}" }, "ana")).rejects.toThrow();
    await expect(updateAutomation(db, combo.id, row.id, { url: "http://u:p@hooks.test/x" }, "ana")).rejects.toThrow();
    await expect(updateAutomation(db, combo.id, row.id, { mode: "api", headers: { Authorization: "literal" } }, "ana")).rejects.toThrow();
  });

  it("automação de outra combinação é NotFoundError", async () => {
    const { row } = await setup();
    const other = await newCombination();
    await expect(updateAutomation(db, other.id, row.id, { enabled: false }, "ana")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("o schema de atualização rejeita corpo vazio", () => {
    expect(() => updateAutomationSchema.parse({})).toThrow();
  });
});

describe("findTriggeredAutomations", () => {
  it("devolve só as ativas cujo gatilho contém o estado", async () => {
    const combo = await newCombination();
    const onAlert = await addAutomation(db, combo.id, combinationAutomationSchema.parse({ ...base, name: "a" }), "t");
    const onBoth = await addAutomation(db, combo.id, combinationAutomationSchema.parse({ ...base, name: "b", triggerStates: ["alert", "ok"] }), "t");
    const off = await addAutomation(db, combo.id, combinationAutomationSchema.parse({ ...base, name: "c", enabled: false }), "t");
    const names = async (state: "alert" | "ok") => (await findTriggeredAutomations(db, combo.id, state)).map((r) => r.name).sort();
    expect(await names("alert")).toEqual(["a", "b"]);
    expect(await names("ok")).toEqual(["b"]);
    expect([onAlert.id, onBoth.id, off.id]).toHaveLength(3);
    await updateAutomation(db, combo.id, onBoth.id, { enabled: false }, "t");
    expect(await names("alert")).toEqual(["a"]);
  });
});

describe("runAutomations", () => {
  const pendingFor = async (input: Record<string, unknown>, state: "alert" | "ok" = "alert") => {
    const combo = await newCombination(["alert", "alert"]);
    const automation = await addAutomation(db, combo.id, combinationAutomationSchema.parse({ ...base, ...input }), "t");
    const pending: PendingAutomation = { automation, combinationId: combo.id, state, previousState: state === "alert" ? "pending" : "alert" };
    return { combo, automation, pending };
  };

  it("chama o destino com o payload padrão, registra a execução e audita", async () => {
    const { combo, automation, pending } = await pendingFor({});
    const fetchImpl = vi.fn(async () => okResponse());
    await runAutomations(db, [pending], deps(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(base.url);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      source: "global-alerts",
      combination: { id: combo.id, name: combo.name, state: "alert", previous_state: "pending", rule: "and", min_count: null, duration_seconds: 120 },
    });
    expect(body.combination.components).toHaveLength(2);
    expect(body.combination.components[0]).toMatchObject({ name: "Alerta 0", application: expect.any(String), state: "alert", priority: 2 });
    expect(typeof body.firedAt).toBe("string");
    const [run] = await db.select().from(combinationAutomationRuns).where(eq(combinationAutomationRuns.automationId, automation.id));
    expect(run).toMatchObject({ combinationId: combo.id, triggerState: "alert", status: "success", httpStatus: 200 });
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.combinationId, combo.id), eq(auditLog.kind, "combination_automation_run")));
    expect(entry.details).toMatchObject({ automationId: automation.id, status: "success" });
  });

  it("modo api usa o modelo com as variáveis da combinação", async () => {
    const { pending } = await pendingFor(
      { mode: "api", method: "PUT", bodyTemplate: '{"c":"{{combination.name}}","s":"{{combination.state}}","p":"{{combination.previous_state}}","l":"{{combination.components}}"}' },
      "ok",
    );
    const fetchImpl = vi.fn(async () => okResponse());
    await runAutomations(db, [pending], deps(fetchImpl));
    const init = (fetchImpl.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toMatchObject({ s: "ok", p: "alert", l: "Alerta 0,Alerta 1" });
  });

  it("pula destino fora da lista sem chamar a rede", async () => {
    const { automation, pending } = await pendingFor({});
    const fetchImpl = vi.fn(async () => okResponse());
    await runAutomations(db, [pending], deps(fetchImpl, ["outro.test"]));
    expect(fetchImpl).not.toHaveBeenCalled();
    const [run] = await db.select().from(combinationAutomationRuns).where(eq(combinationAutomationRuns.automationId, automation.id));
    expect(run.status).toBe("skipped");
  });

  it("resposta 500 vira failed com HTTP 500", async () => {
    const { automation, pending } = await pendingFor({});
    await runAutomations(db, [pending], deps(vi.fn(async () => okResponse(500))));
    const [run] = await db.select().from(combinationAutomationRuns).where(eq(combinationAutomationRuns.automationId, automation.id));
    expect(run).toMatchObject({ status: "failed", httpStatus: 500, error: "HTTP 500" });
  });

  it("variável env: ausente vira failed e a rede não é chamada", async () => {
    const { automation, pending } = await pendingFor({ mode: "api", headers: { Authorization: "env:SEM_VALOR" } });
    const fetchImpl = vi.fn(async () => okResponse());
    await runAutomations(db, [pending], deps(fetchImpl));
    expect(fetchImpl).not.toHaveBeenCalled();
    const [run] = await db.select().from(combinationAutomationRuns).where(eq(combinationAutomationRuns.automationId, automation.id));
    expect(run.status).toBe("failed");
    expect(run.error).toContain("SEM_VALOR");
  });
});
