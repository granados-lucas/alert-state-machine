import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, remediationRuns } from "@/db/schema";
import { createTestDb } from "@/test/db";
import { createAlert } from "./alerts";
import type { Db } from "./db-types";
import { isAllowedDestination, remediationInputSchema, renderTemplate, resolveHeaders, runRemediations, type PendingRemediation } from "./remediation";
import { addRemediation } from "./alerts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const okResponse = (status = 200) => new Response(null, { status });
const base = { name: "restart", mode: "webhook" as const, url: "http://hooks.test:9000/fix" };

describe("remediationInputSchema", () => {
  it("aplica padrões e aceita um webhook simples", () => {
    expect(remediationInputSchema.parse(base)).toMatchObject({ method: "POST", triggerStates: ["alert"], timeoutMs: 5000, enabled: true, headers: {} });
  });

  it("exige env:NOME em headers sensíveis e aceita headers comuns", () => {
    expect(() => remediationInputSchema.parse({ ...base, mode: "api", headers: { Authorization: "Bearer abc" } })).toThrow();
    expect(remediationInputSchema.parse({ ...base, mode: "api", headers: { Authorization: "env:TOKEN_X", "X-Team": "ops" } }).headers).toEqual({
      Authorization: "env:TOKEN_X",
      "X-Team": "ops",
    });
  });

  it("rejeita credenciais na URL, esquemas não HTTP e webhook com método ou corpo próprio", () => {
    expect(() => remediationInputSchema.parse({ ...base, url: "http://u:p@h.test/x" })).toThrow();
    expect(() => remediationInputSchema.parse({ ...base, url: "ftp://h.test/x" })).toThrow();
    expect(() => remediationInputSchema.parse({ ...base, method: "PUT" })).toThrow();
    expect(() => remediationInputSchema.parse({ ...base, bodyTemplate: "{}" })).toThrow();
  });
});

describe("helpers", () => {
  it("isAllowedDestination aceita host ou host:porta da lista", () => {
    const list = ["hooks.test", "other.test:8080"];
    expect(isAllowedDestination(new URL("http://hooks.test:9000/x"), list)).toBe(true);
    expect(isAllowedDestination(new URL("http://other.test:8080/x"), list)).toBe(true);
    expect(isAllowedDestination(new URL("http://other.test:9/x"), list)).toBe(false);
    expect(isAllowedDestination(new URL("http://169.254.169.254/x"), list)).toBe(false);
    expect(isAllowedDestination(new URL("http://hooks.test/x"), [])).toBe(false);
  });

  it("resolveHeaders troca referências env: e falha se a variável não existe", () => {
    expect(resolveHeaders({ A: "env:TOK", B: "plain" }, { TOK: "s3" })).toEqual({ A: "s3", B: "plain" });
    expect(() => resolveHeaders({ A: "env:MISSING" }, {})).toThrow("MISSING");
  });

  it("renderTemplate escapa valores para JSON", () => {
    const ctx = { id: 7, name: 'say "hi"\n', application: "a", state: "alert" as const, previousState: null, priority: null, tags: ["x", "y"], link: null };
    const out = renderTemplate('{"n":"{{alert.name}}","s":"{{alert.state}}","t":"{{alert.tags}}","u":"{{alert.nope}}"}', ctx);
    expect(JSON.parse(out)).toEqual({ n: 'say "hi"\n', s: "alert", t: "x,y", u: "" });
  });
});

async function setup(remediation: Record<string, unknown>) {
  const suffix = Math.random().toString(36).slice(2);
  const alert = await createAlert(db, { provider: "datadog", externalId: `m-${suffix}`, name: "Falha", application: "pay", tags: ["t"], remediations: [] }, "tester");
  const row = await addRemediation(db, alert.id, remediationInputSchema.parse({ ...base, ...remediation }), "tester");
  const pending: PendingRemediation = { remediation: row, state: "alert", previousState: "ok", eventId: null };
  return { alert, pending };
}
const deps = (fetchImpl: typeof fetch, allowedHosts = ["hooks.test"], env: Record<string, string> = {}) => ({ fetch: fetchImpl, allowedHosts, env });

describe("runRemediations", () => {
  it("chama o destino com o payload padrão, registra a execução e audita", async () => {
    const { alert, pending } = await setup({});
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    await runRemediations(db, [pending], deps(fetchMock));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://hooks.test:9000/fix");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(JSON.parse(init.body)).toMatchObject({ source: "global-alerts", alert: { id: alert.id, state: "alert", previous_state: "ok" } });
    const [run] = await db.select().from(remediationRuns).where(eq(remediationRuns.alertId, alert.id));
    expect(run).toMatchObject({ status: "success", httpStatus: 200, triggerState: "alert" });
    const kinds = (await db.select().from(auditLog).where(eq(auditLog.alertId, alert.id))).map((a) => a.kind);
    expect(kinds).toContain("remediation_run");
  });

  it("pula destinos fora da lista permitida sem chamar a rede", async () => {
    const { alert, pending } = await setup({ url: "http://internal.test/x" });
    const fetchMock = vi.fn();
    await runRemediations(db, [pending], deps(fetchMock));
    expect(fetchMock).not.toHaveBeenCalled();
    const [run] = await db.select().from(remediationRuns).where(eq(remediationRuns.alertId, alert.id));
    expect(run).toMatchObject({ status: "skipped", httpStatus: null });
  });

  it("marca como failed respostas não 2xx e erros de rede, sem vazar a URL", async () => {
    const a = await setup({});
    await runRemediations(db, [a.pending], deps(vi.fn().mockResolvedValue(okResponse(503))));
    expect((await db.select().from(remediationRuns).where(eq(remediationRuns.alertId, a.alert.id)))[0]).toMatchObject({ status: "failed", httpStatus: 503, error: "HTTP 503" });

    const b = await setup({});
    await runRemediations(db, [b.pending], deps(vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED http://hooks.test:9000/fix?token=abc"))));
    const [run] = await db.select().from(remediationRuns).where(eq(remediationRuns.alertId, b.alert.id));
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Error");
  });

  it("traduz timeout e resolve headers de ambiente no modo api com modelo", async () => {
    const t = await setup({});
    const timeout = Object.assign(new Error("x"), { name: "TimeoutError" });
    await runRemediations(db, [t.pending], deps(vi.fn().mockRejectedValue(timeout)));
    expect((await db.select().from(remediationRuns).where(eq(remediationRuns.alertId, t.alert.id)))[0].error).toBe("timeout");

    const s = await setup({
      mode: "api",
      method: "PUT",
      headers: { Authorization: "env:FIX_TOKEN" },
      bodyTemplate: '{"host":"{{alert.application}}","state":"{{alert.state}}"}',
    });
    const fetchMock = vi.fn().mockResolvedValue(okResponse(204));
    await runRemediations(db, [s.pending], deps(fetchMock, ["hooks.test"], { FIX_TOKEN: "abc" }));
    const init = fetchMock.mock.calls[0][1];
    expect(init).toMatchObject({ method: "PUT", headers: { Authorization: "abc", "content-type": "application/json" } });
    expect(JSON.parse(init.body)).toEqual({ host: "pay", state: "alert" });
  });

  it("falha de forma controlada quando a variável de ambiente do header falta", async () => {
    const s = await setup({ mode: "api", headers: { Authorization: "env:ABSENT_VAR" } });
    const fetchMock = vi.fn();
    await runRemediations(db, [s.pending], deps(fetchMock));
    expect(fetchMock).not.toHaveBeenCalled();
    const [run] = await db.select().from(remediationRuns).where(eq(remediationRuns.alertId, s.alert.id));
    expect(run).toMatchObject({ status: "failed" });
    expect(run.error).toContain("ABSENT_VAR");
  });

  it("GET e DELETE não enviam corpo", async () => {
    const s = await setup({ mode: "api", method: "GET" });
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    await runRemediations(db, [s.pending], deps(fetchMock));
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it("limita chamadas de saída simultâneas e executa todas", async () => {
    const items = await Promise.all(Array.from({ length: 9 }, () => setup({})));
    let active = 0;
    let peak = 0;
    const slowFetch = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      return okResponse();
    });
    await runRemediations(db, items.map((i) => i.pending), deps(slowFetch as unknown as typeof fetch));
    expect(slowFetch).toHaveBeenCalledTimes(9);
    expect(peak).toBeLessThanOrEqual(4);
    const runs = await db.select().from(remediationRuns).where(eq(remediationRuns.status, "success"));
    expect(runs.length).toBeGreaterThanOrEqual(9);
  });
});
