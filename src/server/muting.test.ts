import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { alerts, auditLog } from "@/db/schema";
import { ProviderApiError, type AlertProvider, type MonitorControl } from "@/providers/types";
import { createTestDb } from "@/test/db";
import { createAlert, createAlertSchema } from "./alerts";
import type { Db } from "./db-types";
import { NotConfiguredError, NotFoundError, UnsupportedError, ValidationError } from "./errors";
import { muteAlert, muteSchema, unmuteAlert, unmuteSchema } from "./muting";
import { remediationInputSchema } from "./remediation";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const NOW = new Date("2026-03-01T10:00:00Z");
const control = (): MonitorControl & { mute: ReturnType<typeof vi.fn>; unmute: ReturnType<typeof vi.fn> } => ({
  mute: vi.fn().mockResolvedValue({ rawState: "OK", event: "recovered" }),
  unmute: vi.fn().mockResolvedValue({ rawState: "OK", event: "recovered" }),
});
const deps = (c: MonitorControl | undefined, provider = "datadog") => ({
  getProvider: (id: string): AlertProvider | undefined => (id === provider ? ({ id, control: c } as AlertProvider) : undefined),
  now: () => NOW,
});

let seq = 0;
async function newAlert(over: Record<string, unknown> = {}) {
  seq += 1;
  return createAlert(db, createAlertSchema.parse({ externalId: `${1000 + seq}`, name: `Monitor ${seq}`, application: "pay", ...over }), "ana");
}
const audit = async (id: number) => (await db.select().from(auditLog).where(eq(auditLog.alertId, id)).orderBy(auditLog.id)).map((a) => a.kind);

describe("muteAlert", () => {
  it("silencia no provedor com o prazo certo, grava o estado local e audita motivo e ator", async () => {
    const alert = await newAlert();
    const c = control();
    const result = await muteAlert(db, alert.id, muteSchema.parse({ minutes: 60, reason: "deploy em andamento", scope: "host:a" }), "bia", deps(c));
    expect(c.mute).toHaveBeenCalledWith(alert.externalId, { until: new Date("2026-03-01T11:00:00Z"), scope: "host:a" });
    expect(result.mutedUntil).toEqual(new Date("2026-03-01T11:00:00Z"));
    const [row] = await db.select().from(alerts).where(eq(alerts.id, alert.id));
    expect(row).toMatchObject({ mutedScope: "host:a", muteReason: "deploy em andamento", mutedBy: "bia" });
    expect(await audit(alert.id)).toContain("monitor_muted");
    expect(row).toMatchObject({ providerState: "OK" });
    expect(row.providerStateAt).toEqual(NOW);
    const entry = (await db.select().from(auditLog).where(eq(auditLog.alertId, alert.id))).find((a) => a.kind === "monitor_muted");
    expect(entry).toMatchObject({ actor: "bia", details: { reason: "deploy em andamento", minutes: 60, scope: "host:a", providerState: "OK" } });
  });

  it("aplica o estado informado pelo provedor, que pode estar mais novo que o local, e devolve as remediações", async () => {
    const alert = await newAlert({ remediations: [remediationInputSchema.parse({ name: "fix", mode: "webhook", url: "http://hooks.test/x" })] });
    const c = control();
    c.mute.mockResolvedValue({ rawState: "Alert", event: "triggered" });
    const result = await muteAlert(db, alert.id, muteSchema.parse({ minutes: 5, reason: "manutenção" }), "bia", deps(c));
    expect(result.synced).toMatchObject({ outcome: "applied", to: "alert" });
    expect(result.synced?.pending.map((p) => p.remediation.name)).toEqual(["fix"]);
    expect(await audit(alert.id)).toEqual(expect.arrayContaining(["monitor_muted", "state_changed"]));
  });

  it("não sincroniza quando o provedor não informa um estado utilizável", async () => {
    const alert = await newAlert();
    const c = control();
    c.mute.mockResolvedValue({ rawState: "Unknown", event: null });
    expect((await muteAlert(db, alert.id, muteSchema.parse({ minutes: 5, reason: "teste" }), "bia", deps(c))).synced).toBeNull();
  });

  it("falha do provedor: audita a tentativa, não altera o alerta e repassa o erro", async () => {
    const alert = await newAlert();
    const c = control();
    c.mute.mockRejectedValue(new ProviderApiError("Datadog responded 403: Forbidden", 403));
    await expect(muteAlert(db, alert.id, muteSchema.parse({ minutes: 5, reason: "teste" }), "bia", deps(c))).rejects.toMatchObject({ status: 403 });
    const [row] = await db.select().from(alerts).where(eq(alerts.id, alert.id));
    expect(row.mutedUntil).toBeNull();
    const entry = (await db.select().from(auditLog).where(eq(auditLog.alertId, alert.id))).find((a) => a.kind === "monitor_mute_failed");
    expect(entry?.details).toMatchObject({ action: "mute", status: 403, message: "Datadog responded 403: Forbidden" });
  });

  it("registra erro genérico (não do provedor) com status nulo", async () => {
    const alert = await newAlert();
    const c = control();
    c.mute.mockRejectedValue(new Error("boom"));
    await expect(muteAlert(db, alert.id, muteSchema.parse({ minutes: 5, reason: "teste" }), "bia", deps(c))).rejects.toThrow("boom");
    const entry = (await db.select().from(auditLog).where(eq(auditLog.alertId, alert.id))).find((a) => a.kind === "monitor_mute_failed");
    expect(entry?.details).toMatchObject({ status: null, message: "boom" });
  });

  it("recusa alerta inexistente, arquivado, de provedor desconhecido ou sem credenciais", async () => {
    const input = muteSchema.parse({ minutes: 5, reason: "teste" });
    await expect(muteAlert(db, 999999, input, "bia", deps(control()))).rejects.toBeInstanceOf(NotFoundError);
    const archived = await newAlert();
    await db.update(alerts).set({ archivedAt: new Date() }).where(eq(alerts.id, archived.id));
    await expect(muteAlert(db, archived.id, input, "bia", deps(control()))).rejects.toBeInstanceOf(ValidationError);
    const other = await newAlert({ provider: "newrelic" });
    await expect(muteAlert(db, other.id, input, "bia", deps(control()))).rejects.toBeInstanceOf(UnsupportedError);
    const plain = await newAlert();
    await expect(muteAlert(db, plain.id, input, "bia", deps(undefined))).rejects.toBeInstanceOf(NotConfiguredError);
  });
});

describe("unmuteAlert", () => {
  it("remove o silêncio usando o escopo guardado, limpa o estado local e audita", async () => {
    const alert = await newAlert();
    const c = control();
    await muteAlert(db, alert.id, muteSchema.parse({ minutes: 30, reason: "janela", scope: "env:prod" }), "bia", deps(c));
    await unmuteAlert(db, alert.id, unmuteSchema.parse({ reason: "janela terminou" }), "caio", deps(c));
    expect(c.unmute).toHaveBeenCalledWith(alert.externalId, { scope: "env:prod", allScopes: false });
    const [row] = await db.select().from(alerts).where(eq(alerts.id, alert.id));
    expect(row).toMatchObject({ mutedUntil: null, mutedScope: null, muteReason: null, mutedBy: null });
    const entry = (await db.select().from(auditLog).where(eq(auditLog.alertId, alert.id))).find((a) => a.kind === "monitor_unmuted");
    expect(entry).toMatchObject({ actor: "caio", details: { reason: "janela terminou", scope: "env:prod" } });
  });

  it("allScopes ignora o escopo guardado e pede ao provedor para limpar tudo", async () => {
    const alert = await newAlert();
    const c = control();
    await muteAlert(db, alert.id, muteSchema.parse({ minutes: 30, reason: "janela", scope: "env:prod" }), "bia", deps(c));
    await unmuteAlert(db, alert.id, unmuteSchema.parse({ allScopes: true }), "caio", deps(c));
    expect(c.unmute).toHaveBeenCalledWith(alert.externalId, { scope: undefined, allScopes: true });
  });

  it("falha do provedor mantém o silêncio local e audita a tentativa", async () => {
    const alert = await newAlert();
    const c = control();
    await muteAlert(db, alert.id, muteSchema.parse({ minutes: 30, reason: "janela" }), "bia", deps(c));
    c.unmute.mockRejectedValue(new ProviderApiError("Datadog responded 429", 429));
    await expect(unmuteAlert(db, alert.id, unmuteSchema.parse({}), "caio", deps(c))).rejects.toMatchObject({ status: 429 });
    const [row] = await db.select().from(alerts).where(eq(alerts.id, alert.id));
    expect(row.mutedUntil).not.toBeNull();
    expect(await audit(alert.id)).toContain("monitor_mute_failed");
  });

  it("sincroniza o estado informado ao reativar (ex.: ficou em Alerta durante o silêncio)", async () => {
    const alert = await newAlert();
    const c = control();
    await muteAlert(db, alert.id, muteSchema.parse({ minutes: 30, reason: "janela" }), "bia", deps(c));
    c.unmute.mockResolvedValue({ rawState: "Alert", event: "triggered" });
    const result = await unmuteAlert(db, alert.id, unmuteSchema.parse({}), "caio", deps(c));
    expect(result.synced).toMatchObject({ outcome: "applied", to: "alert" });
  });
});

describe("validação", () => {
  it("exige prazo entre 1 minuto e 7 dias e um motivo", () => {
    expect(() => muteSchema.parse({ minutes: 0, reason: "abc" })).toThrow();
    expect(() => muteSchema.parse({ minutes: 10081, reason: "abc" })).toThrow();
    expect(() => muteSchema.parse({ minutes: 10, reason: "ab" })).toThrow();
    expect(() => muteSchema.parse({ minutes: 10 })).toThrow();
    expect(muteSchema.parse({ minutes: 10080, reason: "abc" }).minutes).toBe(10080);
  });
});
