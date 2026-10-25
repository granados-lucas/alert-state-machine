import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { alerts, muteOperations, reconciliationRuns } from "@/db/schema";
import { renderPrometheus, PREFIX } from "@/lib/metrics";
import { createTestDb } from "@/test/db";
import type { Db } from "./db-types";
import { ingestEvent } from "./ingest";
import { readTelemetry, toGauges, type ProviderStatus } from "./telemetry";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const providers: ProviderStatus[] = [
  { id: "datadog", webhook: true, control: true, source: true },
  { id: "cloudwatch", webhook: false, control: false, source: false },
];
const info = { version: "9.9.9", startedAt: new Date("2026-03-01T10:00:00Z"), now: new Date("2026-03-01T10:10:00Z") };

const event = (provider: string, id: string, kind: "triggered" | "recovered", at: Date) => ({
  provider, externalEventId: `${provider}-${id}-${kind}`, externalAlertId: `${provider}-${id}`, alertName: id, application: "obs", event: kind, occurredAt: at, priority: null, tags: [], link: null, raw: {},
});

describe("readTelemetry", () => {
  it("banco vazio: tudo zerado, banco no ar", async () => {
    const t = await readTelemetry(db, { providers });
    expect(t.db.up).toBe(true);
    expect(t.alertsByState).toEqual({ ok: 0, warn: 0, alert: 0, no_data: 0 });
    expect(t.providers.map((p) => p.lastEventAt)).toEqual([null, null]);
    expect(t.pendingMutes).toEqual({ count: 0, oldestAt: null });
    expect(t.lastReconciliation).toBeNull();
    expect(t.recentRemediations).toEqual({ total: 0, failed: 0, skipped: 0 });
  });

  it("conta alertas por estado, o último evento por fonte, silêncios pendentes e a última reconciliação", async () => {
    const at = new Date("2026-03-01T09:00:00Z");
    await ingestEvent(db, event("datadog", "a", "triggered", at));
    await ingestEvent(db, event("datadog", "b", "recovered", at));
    await ingestEvent(db, event("datadog", "c", "triggered", new Date(at.getTime() + 60_000)));
    const [alert] = await db.select().from(alerts).where(eq(alerts.externalId, "datadog-a"));
    await db.insert(muteOperations).values({ alertId: alert.id, action: "mute", actor: "ana", reason: "x", until: new Date(), createdAt: new Date("2026-03-01T09:30:00Z") });
    await db.insert(reconciliationRuns).values({ provider: "datadog", trigger: "manual", actor: "ana", status: "succeeded", dryRun: true });

    const t = await readTelemetry(db, { providers, pool: { total: 2, idle: 1, waiting: 0 } });
    expect(t.alertsByState).toMatchObject({ alert: 2, ok: 1 });
    expect(t.providers.find((p) => p.id === "datadog")?.lastEventAt).toEqual(new Date(at.getTime() + 60_000));
    expect(t.providers.find((p) => p.id === "cloudwatch")?.lastEventAt).toBeNull();
    expect(t.pendingMutes).toEqual({ count: 1, oldestAt: new Date("2026-03-01T09:30:00Z") });
    expect(t.lastReconciliation).toMatchObject({ provider: "datadog", status: "succeeded", dryRun: true });
    expect(t.pool).toEqual({ total: 2, idle: 1, waiting: 0 });
  });

  it("banco fora (consulta falha) ou sem configuração: responde com banco indisponível, sem lançar", async () => {
    const broken = { execute: () => Promise.reject(new Error("down")) } as unknown as Db;
    expect((await readTelemetry(broken, { providers })).db).toEqual({ up: false, latencyMs: null });
    const none = await readTelemetry(undefined, { providers });
    expect(none.db.up).toBe(false);
    expect(none.providers).toHaveLength(2);
  });
});

describe("toGauges", () => {
  it("publica versão, banco, alertas, último evento por fonte, silêncios e pool", async () => {
    const t = await readTelemetry(db, { providers, pool: { total: 3, idle: 2, waiting: 1 } });
    const text = renderPrometheus(toGauges(t, info));
    expect(text).toContain(`${PREFIX}build_info{version="9.9.9"} 1`);
    expect(text).toContain(`${PREFIX}process_uptime_seconds 600`);
    expect(text).toContain(`${PREFIX}database_up 1`);
    expect(text).toMatch(new RegExp(`${PREFIX}alerts\\{state="alert"\\} \\d+`));
    expect(text).toContain(`${PREFIX}last_event_timestamp_seconds{provider="datadog"} ${Math.floor(Date.parse("2026-03-01T09:01:00Z") / 1000)}`);
    expect(text).toContain(`${PREFIX}last_event_timestamp_seconds{provider="cloudwatch"} 0`);
    expect(text).toContain(`${PREFIX}provider_webhook_enabled{provider="cloudwatch"} 0`);
    expect(text).toContain(`${PREFIX}mute_operations_pending 1`);
    expect(text).toContain(`${PREFIX}mute_operations_oldest_pending_seconds 2400`);
    expect(text).toContain(`${PREFIX}database_pool_connections{state="waiting"} 1`);
    expect(text).toMatch(new RegExp(`${PREFIX}database_latency_seconds `));
  });

  it("com o banco fora não inventa latência nem pool", async () => {
    const t = await readTelemetry(undefined, { providers });
    const text = renderPrometheus(toGauges(t, info));
    expect(text).toContain(`${PREFIX}database_up 0`);
    expect(text).not.toContain("database_latency_seconds ");
    expect(text).not.toContain("database_pool_connections{");
  });
});
