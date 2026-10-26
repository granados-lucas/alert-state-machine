import { describe, expect, it } from "vitest";
import { ProviderPayloadError } from "../types";
import { applicationFromTags } from "../common";
import { createDatadogProvider } from "./index";

const provider = createDatadogProvider({});
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

describe("applicationFromTags", () => {
  it("prefere service, depois app e application", () => {
    expect(applicationFromTags(["app:b", "service:a"])).toBe("a");
    expect(applicationFromTags(["application:c"])).toBe("c");
    expect(applicationFromTags(["service:"])).toBe("unassigned");
  });
});
