import { describe, expect, it } from "vitest";
import {
  automationToValues,
  buildAutomationBody,
  buildCombinationPayload,
  describeRule,
  emptyAutomation,
  emptyCombination,
  formatDuration,
} from "./payload";

describe("formatDuration", () => {
  it("escreve segundos, minutos e horas", () => {
    expect(formatDuration(30)).toBe("30 s");
    expect(formatDuration(120)).toBe("2 min");
    expect(formatDuration(150)).toBe("2 min 30 s");
    expect(formatDuration(7200)).toBe("2 h");
  });
});

describe("describeRule", () => {
  it("descreve as três regras e omite a duração zero", () => {
    expect(describeRule({ rule: "and", minCount: null, durationSeconds: 120 }, 2)).toBe("E · 2 min");
    expect(describeRule({ rule: "or", minCount: null, durationSeconds: 0 }, 3)).toBe("OU");
    expect(describeRule({ rule: "at_least", minCount: 2, durationSeconds: 300 }, 3)).toBe("Pelo menos 2 de 3 · 5 min");
  });
});

describe("buildCombinationPayload", () => {
  const values = { ...emptyCombination, name: " Checkout fora ", rule: "and" as const, minutes: "2", alertIds: [4, 9] };

  it("converte minutos em segundos, apara textos e não manda N nas regras E e OU", () => {
    const result = buildCombinationPayload(values, "create");
    expect(result).toEqual({
      ok: true,
      body: { name: "Checkout fora", description: null, rule: "and", minCount: null, durationSeconds: 120, alertIds: [4, 9], automations: [] },
    });
  });

  it("pelo menos N manda minCount como número", () => {
    const result = buildCombinationPayload({ ...values, rule: "at_least", minCount: "2" }, "create");
    expect(result).toMatchObject({ ok: true, body: { rule: "at_least", minCount: 2 } });
  });

  it("na edição não manda automações", () => {
    const result = buildCombinationPayload({ ...values, addAutomation: true, automation: { ...emptyAutomation, url: "http://hooks.test/x" } }, "edit");
    expect(result.ok && "automations" in (result.body as object)).toBe(false);
  });

  it("na criação inclui a automação quando marcada", () => {
    const result = buildCombinationPayload({ ...values, addAutomation: true, automation: { ...emptyAutomation, name: "r", url: "http://hooks.test/x" } }, "create");
    expect(result).toMatchObject({ ok: true, body: { automations: [{ name: "r", url: "http://hooks.test/x", triggerStates: ["alert"] }] } });
  });

  it("recusa sem alertas, N inválido, duração negativa e automação com cabeçalhos inválidos", () => {
    expect(buildCombinationPayload({ ...values, alertIds: [] }, "create")).toMatchObject({ ok: false });
    expect(buildCombinationPayload({ ...values, rule: "at_least", minCount: "" }, "create")).toMatchObject({ ok: false });
    expect(buildCombinationPayload({ ...values, rule: "at_least", minCount: "0" }, "create")).toMatchObject({ ok: false });
    expect(buildCombinationPayload({ ...values, minutes: "-1" }, "create")).toMatchObject({ ok: false });
    expect(buildCombinationPayload({ ...values, addAutomation: true, automation: { ...emptyAutomation, headers: "{" } }, "create")).toMatchObject({ ok: false });
  });
});

describe("buildAutomationBody", () => {
  it("webhook sempre POST e sem modelo de corpo", () => {
    const result = buildAutomationBody({ ...emptyAutomation, name: " r ", url: " http://hooks.test/x ", method: "PUT", bodyTemplate: "{}" });
    expect(result).toEqual({
      ok: true,
      body: { name: "r", mode: "webhook", url: "http://hooks.test/x", method: "POST", headers: {}, bodyTemplate: null, triggerStates: ["alert"], timeoutMs: 5000, enabled: true },
    });
  });

  it("modo api manda método, cabeçalhos e modelo", () => {
    const result = buildAutomationBody({
      ...emptyAutomation,
      name: "r",
      mode: "api",
      url: "http://hooks.test/x",
      method: "PUT",
      headers: '{"Authorization":"env:MEU_TOKEN"}',
      bodyTemplate: '{"c":"{{combination.name}}"}',
      triggerStates: ["alert", "ok"],
      timeoutMs: "2000",
      enabled: false,
    });
    expect(result).toMatchObject({
      ok: true,
      body: { mode: "api", method: "PUT", headers: { Authorization: "env:MEU_TOKEN" }, bodyTemplate: '{"c":"{{combination.name}}"}', triggerStates: ["alert", "ok"], timeoutMs: 2000, enabled: false },
    });
  });

  it("recusa cabeçalhos que não são um objeto JSON e exige pelo menos um gatilho", () => {
    expect(buildAutomationBody({ ...emptyAutomation, headers: "[1]" })).toMatchObject({ ok: false });
    expect(buildAutomationBody({ ...emptyAutomation, headers: "nao json" })).toMatchObject({ ok: false });
    expect(buildAutomationBody({ ...emptyAutomation, triggerStates: [] })).toMatchObject({ ok: false });
  });
});

describe("automationToValues", () => {
  it("preenche o formulário de edição a partir da automação gravada", () => {
    expect(
      automationToValues({
        name: "r",
        mode: "api",
        url: "http://hooks.test/x",
        method: "PUT",
        headers: { Authorization: "env:T" },
        bodyTemplate: "{}",
        triggerStates: ["alert", "ok"],
        timeoutMs: 2000,
        enabled: false,
      }),
    ).toEqual({
      name: "r",
      mode: "api",
      url: "http://hooks.test/x",
      method: "PUT",
      headers: '{\n  "Authorization": "env:T"\n}',
      bodyTemplate: "{}",
      triggerStates: ["alert", "ok"],
      timeoutMs: "2000",
      enabled: false,
    });
  });

  it("cabeçalhos vazios e corpo nulo viram campos vazios", () => {
    expect(automationToValues({ name: "r", mode: "webhook", url: "u", method: "POST", headers: {}, bodyTemplate: null, triggerStates: ["alert"], timeoutMs: 5000, enabled: true })).toMatchObject({ headers: "", bodyTemplate: "" });
  });
});
