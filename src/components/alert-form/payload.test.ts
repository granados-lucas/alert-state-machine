import { describe, expect, it } from "vitest";
import { buildCreatePayload, emptyValues, type FormValues } from "./payload";

const base: FormValues = { ...emptyValues, externalId: " 123 ", name: " Latência ", application: "checkout", tags: "a, b,,c", priority: "2" };

describe("buildCreatePayload", () => {
  it("monta um alerta sem remediação", () => {
    expect(buildCreatePayload(base)).toEqual({
      ok: true,
      body: { provider: "datadog", externalId: "123", name: "Latência", application: "checkout", priority: 2, tags: ["a", "b", "c"], link: null, remediations: [] },
    });
  });

  it("monta remediação em modo api com headers e modelo", () => {
    const r = buildCreatePayload({
      ...base, remediate: true, mode: "api", method: "PUT", url: " http://h.test/x ", headers: '{"Authorization":"env:T"}',
      bodyTemplate: '{"a":"{{alert.name}}"}', triggerStates: ["alert", "warn"], timeoutMs: "3000", remediationName: "",
    });
    expect(r).toMatchObject({ ok: true });
    expect((r as { body: { remediations: unknown[] } }).body.remediations[0]).toEqual({
      name: "remediação", mode: "api", url: "http://h.test/x", method: "PUT", headers: { Authorization: "env:T" },
      bodyTemplate: '{"a":"{{alert.name}}"}', triggerStates: ["alert", "warn"], timeoutMs: 3000,
    });
  });

  it("webhook sempre usa POST e ignora modelo de corpo", () => {
    const r = buildCreatePayload({ ...base, remediate: true, mode: "webhook", method: "DELETE", url: "http://h.test/x", bodyTemplate: "{}" });
    expect((r as { body: { remediations: Record<string, unknown>[] } }).body.remediations[0]).toMatchObject({ method: "POST", bodyTemplate: null });
  });

  it("recusa headers que não sejam um objeto JSON", () => {
    expect(buildCreatePayload({ ...base, remediate: true, headers: "{nao json" })).toMatchObject({ ok: false });
    expect(buildCreatePayload({ ...base, remediate: true, headers: "[1]" })).toMatchObject({ ok: false });
    expect(buildCreatePayload({ ...base, remediate: true, headers: "null" })).toMatchObject({ ok: false });
  });
});
