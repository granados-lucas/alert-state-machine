import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { alerts, auditLog, reconciliationRuns } from "@/db/schema";
import { ProviderApiError, ProviderRateLimitError, type AlertProvider, type ProviderMonitor, type RateLimitInfo } from "@/providers/types";
import { createTestDb } from "@/test/db";
import { createAlert, createAlertSchema } from "./alerts";
import type { Db } from "./db-types";
import { ConflictError, NotConfiguredError, NotFoundError, UnsupportedError } from "./errors";
import { ingestEvent } from "./ingest";
import { executeReconciliation, getReconciliationRun, listReconciliationRuns, reconcile, reconcileOptionsSchema, startReconciliation } from "./reconcile";
import { remediationInputSchema } from "./remediation";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());
beforeEach(async () => {
  await db.update(reconciliationRuns).set({ status: "failed" }).where(eq(reconciliationRuns.status, "running"));
});

type Step = ProviderMonitor[] | Error | { monitors: ProviderMonitor[]; rateLimit: RateLimitInfo };
const mon = (externalId: string, rawState: string | null, over: Partial<ProviderMonitor> = {}): ProviderMonitor => ({
  externalId,
  name: `Monitor ${externalId}`,
  application: "rec-app",
  rawState,
  event: ({ OK: "recovered", Warn: "warned", Alert: "triggered", "No Data": "data_missing", Unknown: "data_missing" } as const)[rawState as "OK"] ?? null,
  tags: ["service:rec-app"],
  priority: null,
  ...over,
});
function provider(steps: Step[]) {
  const listMonitors = vi.fn(async () => {
    const step = steps.shift();
    if (step === undefined) return { monitors: [], rateLimit: {} };
    if (step instanceof Error) throw step;
    return Array.isArray(step) ? { monitors: step, rateLimit: {} } : step;
  });
  return { listMonitors, provider: { id: "datadog", source: { listMonitors } } as unknown as AlertProvider };
}
const deps = (p: AlertProvider | undefined, extra: Record<string, unknown> = {}) => ({ getProvider: () => p, sleep: vi.fn().mockResolvedValue(undefined), ...extra });
const opts = (o: Record<string, unknown> = {}) => reconcileOptionsSchema.parse(o);

let seq = 0;
const ids = () => `r${++seq}-${Math.random().toString(36).slice(2, 7)}`;
async function seed(state: "ok" | "alert" | "warn", id = ids()) {
  const alert = await createAlert(db, createAlertSchema.parse({ externalId: id, name: `Monitor ${id}`, application: "rec-app" }), "ana");
  const event = ({ ok: "recovered", alert: "triggered", warn: "warned" } as const)[state];
  await ingestEvent(db, { provider: "datadog", externalEventId: `seed-${id}`, externalAlertId: id, alertName: `Monitor ${id}`, application: "rec-app", event, occurredAt: new Date(Date.now() - 60_000), priority: null, tags: [], link: null, raw: {} });
  return { ...alert, externalId: id };
}
const stateOf = async (externalId: string) => (await db.select().from(alerts).where(eq(alerts.externalId, externalId)))[0];

describe("reconcile", () => {
  it("corrige estados divergentes, cria monitores novos, mantém Skipped e guarda o estado bruto", async () => {
    const a = await seed("ok");
    const b = await seed("alert");
    const c = await seed("ok");
    const d = await seed("warn");
    const fresh = ids();
    const { provider: p } = provider([[mon(a.externalId, "Alert"), mon(b.externalId, "Alert"), mon(c.externalId, "Skipped"), mon(d.externalId, "Unknown"), mon(fresh, "Warn")]]);
    const run = await reconcile(db, opts(), "ana", "manual", deps(p));

    expect(run).toMatchObject({ status: "succeeded", dryRun: false, trigger: "manual", actor: "ana" });
    expect(run.summary).toMatchObject({ pages: 1, seen: 5, corrected: 2, inSync: 1, kept: 1, created: 1 });
    expect((await stateOf(a.externalId)).state).toBe("alert");
    expect((await stateOf(c.externalId)).state).toBe("ok"); // Skipped: mantém
    expect((await stateOf(c.externalId)).providerState).toBe("Skipped");
    expect((await stateOf(d.externalId)).state).toBe("no_data"); // Unknown -> sem dados
    const created = await stateOf(fresh);
    expect(created).toMatchObject({ state: "warn", providerState: "Warn" });
    const changes = (await db.select().from(auditLog).where(eq(auditLog.alertId, a.id))).filter((x) => x.kind === "state_changed");
    expect(changes.pop()).toMatchObject({ actor: "system:reconciliation", fromState: "ok", toState: "alert" });
    const audit = (await db.select().from(auditLog)).filter((x) => x.kind === "reconciliation_run").pop();
    expect(audit?.details).toMatchObject({ runId: run.id, status: "succeeded" });
    expect(run.summary.details).toEqual(expect.arrayContaining([expect.objectContaining({ action: "corrected", externalId: a.externalId, from: "ok", to: "alert" })]));
  });

  it("é idempotente: a segunda execução não encontra nada para corrigir", async () => {
    const a = await seed("ok");
    const make = () => provider([[mon(a.externalId, "Alert")]]).provider;
    await reconcile(db, opts(), "ana", "manual", deps(make()));
    const second = await reconcile(db, opts(), "ana", "manual", deps(make()));
    expect(second.summary).toMatchObject({ corrected: 0, created: 0, inSync: 1 });
  });

  it("prévia (dryRun) relata o que mudaria sem alterar nem criar alertas", async () => {
    const a = await seed("ok");
    const fresh = ids();
    const { provider: p } = provider([[mon(a.externalId, "Alert"), mon(fresh, "Alert")]]);
    const run = await reconcile(db, opts({ dryRun: true }), "ana", "manual", deps(p));
    expect(run).toMatchObject({ status: "succeeded", dryRun: true });
    expect(run.summary).toMatchObject({ corrected: 1, created: 1 });
    expect((await stateOf(a.externalId)).state).toBe("ok");
    expect((await stateOf(a.externalId)).providerState).toBeNull();
    expect(await stateOf(fresh)).toBeUndefined();
  });

  it("createMissing desligado ignora monitores desconhecidos; arquivados nunca são ressuscitados", async () => {
    const archived = await seed("ok");
    await db.update(alerts).set({ archivedAt: new Date() }).where(eq(alerts.id, archived.id));
    const unknown = ids();
    const { provider: p } = provider([[mon(unknown, "Alert"), mon(archived.externalId, "Alert")]]);
    const run = await reconcile(db, opts({ createMissing: false }), "ana", "manual", deps(p));
    expect(run.summary).toMatchObject({ skipped: 1, archived: 1, created: 0, corrected: 0 });
    expect(await stateOf(unknown)).toBeUndefined();
    expect((await stateOf(archived.externalId)).state).toBe("ok");
  });

  it("pagina até uma página incompleta e ignora repetidos entre páginas", async () => {
    const a = await seed("ok");
    const many = Array.from({ length: 10 }, () => mon(ids(), "OK"));
    const { provider: p, listMonitors } = provider([many, [many[0], mon(a.externalId, "Warn")]]);
    const run = await reconcile(db, opts({ pageSize: 10 }), "ana", "manual", deps(p));
    expect(listMonitors).toHaveBeenCalledTimes(2);
    expect(listMonitors).toHaveBeenNthCalledWith(2, { page: 1, pageSize: 10, tags: undefined });
    expect(run.summary).toMatchObject({ pages: 2, seen: 11 });
  });

  it("aponta como ausentes os alertas ativos que o provedor não listou, sem arquivá-los", async () => {
    const gone = await seed("alert");
    const { provider: p } = provider([[mon(ids(), "OK")]]);
    const run = await reconcile(db, opts(), "ana", "manual", deps(p));
    expect(run.summary.missing).toBeGreaterThanOrEqual(1);
    expect(run.summary.details).toEqual(expect.arrayContaining([expect.objectContaining({ action: "missing", externalId: gone.externalId })]));
    expect((await stateOf(gone.externalId)).archivedAt).toBeNull();
  });

  it("com filtro de tags não calcula ausentes e repassa o filtro ao provedor", async () => {
    await seed("alert");
    const { provider: p, listMonitors } = provider([[mon(ids(), "OK")]]);
    const run = await reconcile(db, opts({ tags: ["service:rec-app"] }), "ana", "manual", deps(p));
    expect(run.summary.missing).toBe(0);
    expect(listMonitors).toHaveBeenCalledWith({ page: 0, pageSize: 100, tags: ["service:rec-app"] });
  });

  it("descarta o dado lido quando um webhook mais novo chegou durante a leitura (stale)", async () => {
    const a = await seed("ok");
    await ingestEvent(db, { provider: "datadog", externalEventId: `future-${a.externalId}`, externalAlertId: a.externalId, alertName: "x", application: "rec-app", event: "recovered", occurredAt: new Date(Date.now() + 3_600_000), priority: null, tags: [], link: null, raw: {} });
    const { provider: p } = provider([[mon(a.externalId, "Alert")]]);
    const run = await reconcile(db, opts(), "ana", "manual", deps(p));
    expect(run.summary).toMatchObject({ stale: 1, corrected: 0 });
    expect((await stateOf(a.externalId)).state).toBe("ok");
  });

  it("executa as remediações dos alertas corrigidos, a menos que remediate seja falso", async () => {
    const a = await seed("ok");
    await db.transaction(async () => undefined);
    const alertRow = await stateOf(a.externalId);
    const { addRemediation } = await import("./alerts");
    await addRemediation(db, alertRow.id, remediationInputSchema.parse({ name: "fix", mode: "webhook", url: "http://hooks.test/x" }), "ana");
    const runRemediations = vi.fn().mockResolvedValue(undefined);
    const { provider: p } = provider([[mon(a.externalId, "Alert")]]);
    await reconcile(db, opts(), "ana", "manual", deps(p, { runRemediations }));
    expect(runRemediations).toHaveBeenCalledOnce();
    expect(runRemediations.mock.calls[0][0][0].remediation.name).toBe("fix");

    const b = await seed("ok");
    const rb = await stateOf(b.externalId);
    await addRemediation(db, rb.id, remediationInputSchema.parse({ name: "fix", mode: "webhook", url: "http://hooks.test/x" }), "ana");
    const none = vi.fn();
    await reconcile(db, opts({ remediate: false }), "ana", "manual", deps(provider([[mon(b.externalId, "Alert")]]).provider, { runRemediations: none }));
    expect(none).not.toHaveBeenCalled();
  });
});

describe("limites de uso do provedor", () => {
  const limited = (reset: number) => new ProviderRateLimitError("429", { resetSeconds: reset });

  it("429 espera o reset (+1 s) e tenta de novo; a execução termina com sucesso", async () => {
    const a = await seed("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { provider: p, listMonitors } = provider([limited(7), [mon(a.externalId, "Warn")]]);
    const run = await reconcile(db, opts(), "ana", "manual", { getProvider: () => p, sleep });
    expect(sleep).toHaveBeenCalledWith(8000);
    expect(listMonitors).toHaveBeenCalledTimes(2);
    expect(run).toMatchObject({ status: "succeeded" });
    expect(run.summary).toMatchObject({ rateLimited: 1, requests: 2, corrected: 1 });
  });

  it("limita a espera por 429 a 120 s e usa o período quando não há reset", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { provider: p } = provider([limited(9999), new ProviderRateLimitError("429", { period: 30 }), []]);
    await reconcile(db, opts(), "ana", "manual", { getProvider: () => p, sleep });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([121_000, 31_000]);
  });

  it("depois de 5 tentativas seguidas com 429, desiste e marca a execução como falha", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { provider: p, listMonitors } = provider(Array.from({ length: 10 }, () => limited(1)));
    const run = await reconcile(db, opts(), "ana", "manual", { getProvider: () => p, sleep });
    expect(listMonitors).toHaveBeenCalledTimes(6);
    expect(run).toMatchObject({ status: "failed", error: "429" });
    expect(run.summary).toMatchObject({ rateLimited: 5 });
  });

  it("quando resta no máximo 1 requisição na janela, espera o reset antes da próxima página", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const firstPage = Array.from({ length: 10 }, () => mon(ids(), "OK"));
    const { provider: p } = provider([{ monitors: firstPage, rateLimit: { remaining: 1, resetSeconds: 5 } }, []]);
    const run = await reconcile(db, opts({ pageSize: 10 }), "ana", "manual", { getProvider: () => p, sleep });
    expect(sleep).toHaveBeenCalledWith(6000);
    expect(run.rateLimit).toEqual({});
  });

  it("guarda os últimos cabeçalhos de limite vistos", async () => {
    const { provider: p } = provider([{ monitors: [], rateLimit: { limit: 60, period: 3600, remaining: 55, resetSeconds: 100, name: "monitors_read" } }]);
    const run = await reconcile(db, opts(), "ana", "manual", deps(p));
    expect(run.rateLimit).toEqual({ limit: 60, period: 3600, remaining: 55, resetSeconds: 100, name: "monitors_read" });
  });
});

describe("falhas e limites da execução", () => {
  it("erro do provedor encerra como failed mantendo o progresso e a mensagem", async () => {
    const a = await seed("ok");
    const full = Array.from({ length: 10 }, () => mon(ids(), "OK"));
    full[0] = mon(a.externalId, "Alert");
    const { provider: p } = provider([full, new ProviderApiError("Datadog responded 403: Forbidden", 403)]);
    const run = await reconcile(db, opts({ pageSize: 10 }), "ana", "manual", deps(p));
    expect(run).toMatchObject({ status: "failed", error: "Datadog responded 403: Forbidden" });
    expect(run.summary).toMatchObject({ pages: 1, corrected: 1 });
    expect((await stateOf(a.externalId)).state).toBe("alert");
  });

  it("orçamento de tempo esgotado e limite de páginas viram partial", async () => {
    let clock = 0;
    const now = () => new Date(1_000_000 + (clock += 400));
    const page = () => Array.from({ length: 10 }, () => mon(ids(), "OK"));
    const timed = await reconcile(db, opts({ pageSize: 10 }), "ana", "manual", { getProvider: () => provider([page(), page(), page()]).provider, sleep: vi.fn(), now, maxDurationMs: 1000 });
    expect(timed.status).toBe("partial");
    expect(timed.error).toContain("time budget");
    const capped = await reconcile(db, opts({ pageSize: 10, maxPages: 1 }), "ana", "manual", deps(provider([page(), page()]).provider));
    expect(capped).toMatchObject({ status: "partial" });
    expect(capped.error).toContain("page limit");
    expect(capped.summary.missing).toBe(0); // listagem incompleta: nada de "ausentes"
  });

  it("executeReconciliation falha de forma controlada sem provedor configurado", async () => {
    const run = await startReconciliation(db, opts(), "ana", "manual", deps(provider([]).provider));
    const result = await executeReconciliation(db, run.id, opts(), deps(undefined));
    expect(result).toMatchObject({ status: "failed" });
  });
});

describe("início e consulta", () => {
  it("recusa provedor desconhecido ou sem credenciais", async () => {
    await expect(startReconciliation(db, opts(), "ana", "manual", deps(undefined))).rejects.toBeInstanceOf(UnsupportedError);
    await expect(startReconciliation(db, opts(), "ana", "manual", deps({ id: "datadog" } as AlertProvider))).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it("só permite uma execução por vez e libera execuções abandonadas há mais de 30 min", async () => {
    const p = provider([]).provider;
    const t0 = new Date("2026-05-01T10:00:00Z");
    const first = await startReconciliation(db, opts(), "ana", "manual", deps(p, { now: () => t0 }));
    await expect(startReconciliation(db, opts(), "bia", "schedule", deps(p, { now: () => new Date(t0.getTime() + 60_000) }))).rejects.toBeInstanceOf(ConflictError);
    const later = await startReconciliation(db, opts(), "bia", "schedule", deps(p, { now: () => new Date(t0.getTime() + 31 * 60_000) }));
    expect(later.id).toBeGreaterThan(first.id);
    expect(await getReconciliationRun(db, first.id)).toMatchObject({ status: "failed", error: expect.stringContaining("abandoned") });
  });

  it("consulta e lista execuções, da mais recente para a mais antiga", async () => {
    const run = await reconcile(db, opts(), "ana", "manual", deps(provider([[]]).provider));
    expect((await getReconciliationRun(db, run.id)).id).toBe(run.id);
    await expect(getReconciliationRun(db, 99999999)).rejects.toBeInstanceOf(NotFoundError);
    const list = await listReconciliationRuns(db, 3);
    expect(list.length).toBeLessThanOrEqual(3);
    expect(list[0].id).toBeGreaterThanOrEqual(list[list.length - 1].id);
  });
});
