import { describe, expect, it } from "vitest";
import { ProviderPayloadError } from "../types";
import { applicationFromTags, createDatadogProvider, mapTransition } from "./index";

const SECRET = "datadog-secret-0123456789";
const provider = createDatadogProvider({ secret: SECRET });
const base = {
  event_id: "8001",
  monitor_id: 42,
  monitor_name: "High latency on checkout",
  transition: "Triggered",
  alert_type: "error",
  priority: "P2",
  tags: "env:prod, service:checkout ,team:pay",
  last_updated: "1767225600000",
  link: "https://app.datadoghq.com/monitors/42",
};

describe("authenticate", () => {
  it("aceita apenas o segredo correto", () => {
    expect(provider.authenticate(new Headers({ "x-webhook-secret": SECRET }))).toBe(true);
    expect(provider.authenticate(new Headers({ "x-webhook-secret": "wrong-secret-0123456789" }))).toBe(false);
    expect(provider.authenticate(new Headers({ "x-webhook-secret": "short" }))).toBe(false);
    expect(provider.authenticate(new Headers())).toBe(false);
  });

  it("nega tudo quando o segredo não está configurado", () => {
    const open = createDatadogProvider({ secret: undefined });
    expect(open.authenticate(new Headers({ "x-webhook-secret": "" }))).toBe(false);
    expect(open.authenticate(new Headers({ "x-webhook-secret": "anything" }))).toBe(false);
  });
});

describe("parse", () => {
  it("normaliza o payload do Datadog", () => {
    expect(provider.parse(base)).toMatchObject({
      provider: "datadog",
      externalEventId: "8001",
      externalAlertId: "42",
      alertName: "High latency on checkout",
      application: "checkout",
      event: "triggered",
      priority: 2,
      tags: ["env:prod", "service:checkout", "team:pay"],
      link: "https://app.datadoghq.com/monitors/42",
      occurredAt: new Date(1767225600000),
    });
  });

  it("aplica padrões para campos opcionais ausentes", () => {
    const e = provider.parse({ event_id: "1", monitor_id: "2", monitor_name: "n" });
    expect(e).toMatchObject({ application: "unassigned", event: null, priority: null, link: null, tags: [] });
    expect(e.occurredAt).toBeInstanceOf(Date);
  });

  it("descarta links que não sejam http(s)", () => {
    expect(provider.parse({ ...base, link: "javascript:alert(1)" }).link).toBeNull();
    expect(provider.parse({ ...base, link: "não é url" }).link).toBeNull();
  });

  it("rejeita payload inválido", () => {
    expect(() => provider.parse({ monitor_id: "1" })).toThrow(ProviderPayloadError);
    expect(() => provider.parse("texto")).toThrow(ProviderPayloadError);
    expect(() => provider.parse({ ...base, event_id: "" })).toThrow(ProviderPayloadError);
  });
});

describe("mapTransition", () => {
  it.each([
    ["Triggered", "", "triggered"],
    ["Re-Triggered", "", "triggered"],
    ["Recovered", "", "recovered"],
    ["Warn", "", "warned"],
    ["No Data", "", "data_missing"],
    ["", "success", "recovered"],
    ["", "warning", "warned"],
    ["", "error", "triggered"],
    ["Renotify", "info", null],
    ["", "", null],
  ])("%s / %s -> %s", (transition, type, expected) => {
    expect(mapTransition(transition, type)).toBe(expected);
  });
});

describe("applicationFromTags", () => {
  it("prefere service, depois app e application", () => {
    expect(applicationFromTags(["app:b", "service:a"])).toBe("a");
    expect(applicationFromTags(["application:c"])).toBe("c");
    expect(applicationFromTags(["service:"])).toBe("unassigned");
  });
});
