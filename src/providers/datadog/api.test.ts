import { describe, expect, it, vi } from "vitest";
import { ProviderApiError } from "../types";
import { createDatadogControl, eventFromOverallState } from "./api";

const config = { baseUrl: "https://api.datadoghq.com", apiKey: "api-key-12345", appKey: "app-key-12345" };
const monitor = (overall_state: string) => new Response(JSON.stringify({ id: 42, overall_state }), { status: 200 });
const until = new Date("2026-01-01T13:00:00Z");

describe("mute", () => {
  it("chama POST /api/v1/monitor/{id}/mute com end em segundos, escopo e as duas chaves", async () => {
    const fetchMock = vi.fn().mockResolvedValue(monitor("Alert"));
    const snapshot = await createDatadogControl(config, fetchMock).mute("42", { until, scope: "host:app1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.datadoghq.com/api/v1/monitor/42/mute?end=1767272400&scope=host%3Aapp1");
    expect(init).toMatchObject({ method: "POST", redirect: "manual", headers: { "DD-API-KEY": "api-key-12345", "DD-APPLICATION-KEY": "app-key-12345" } });
    expect(snapshot).toEqual({ rawState: "Alert", event: "triggered" });
  });

  it("não envia escopo quando não informado", async () => {
    const fetchMock = vi.fn().mockResolvedValue(monitor("OK"));
    await createDatadogControl(config, fetchMock).mute("7", { until });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.datadoghq.com/api/v1/monitor/7/mute?end=1767272400");
  });
});

describe("unmute", () => {
  it("usa /unmute com escopo ou all_scopes", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => monitor("Warn"));
    const control = createDatadogControl(config, fetchMock);
    expect(await control.unmute("42", { scope: "host:a" })).toEqual({ rawState: "Warn", event: "warned" });
    await control.unmute("42", { allScopes: true });
    await control.unmute("42", {});
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://api.datadoghq.com/api/v1/monitor/42/unmute?scope=host%3Aa",
      "https://api.datadoghq.com/api/v1/monitor/42/unmute?all_scopes=true",
      "https://api.datadoghq.com/api/v1/monitor/42/unmute",
    ]);
  });
});

describe("falhas", () => {
  it("traduz status HTTP e mensagem do Datadog em ProviderApiError sem expor chaves", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: ["Forbidden: missing monitors_write"] }), { status: 403 }));
    const error = await createDatadogControl(config, fetchMock).mute("42", { until }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error).toMatchObject({ status: 403, message: "Datadog responded 403: Forbidden: missing monitors_write" });
    expect(String((error as Error).message)).not.toContain("api-key");
  });

  it("aceita erro sem corpo JSON e estado ausente ou desconhecido", async () => {
    const control = (res: Response) => createDatadogControl(config, vi.fn().mockResolvedValue(res));
    await expect(control(new Response("<html>", { status: 502 })).mute("1", { until })).rejects.toMatchObject({ status: 502, message: "Datadog responded 502" });
    expect(await control(new Response("{}", { status: 200 })).mute("1", { until })).toEqual({ rawState: null, event: null });
    expect(await control(monitor("Skipped")).mute("1", { until })).toEqual({ rawState: "Skipped", event: null });
  });

  it("falha de rede e timeout viram erro sem status e sem a URL", async () => {
    const network = vi.fn().mockRejectedValue(new TypeError("fetch failed https://api.datadoghq.com/secret"));
    const timeout = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { name: "TimeoutError" }));
    const e1 = await createDatadogControl(config, network).mute("1", { until }).catch((e: unknown) => e);
    const e2 = await createDatadogControl(config, timeout).mute("1", { until }).catch((e: unknown) => e);
    expect(e1).toMatchObject({ status: null, message: "Datadog request failed (network error)" });
    expect(e2).toMatchObject({ status: null, message: "Datadog request failed (timeout)" });
  });

  it("recusa id de monitor que não seja numérico antes de chamar a rede", async () => {
    const fetchMock = vi.fn();
    await expect(createDatadogControl(config, fetchMock).mute("../etc", { until })).rejects.toBeInstanceOf(ProviderApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("eventFromOverallState", () => {
  it.each([
    ["OK", "recovered"],
    ["Warn", "warned"],
    ["Alert", "triggered"],
    ["No Data", "data_missing"],
    ["Ignored", null],
    ["Skipped", null],
    ["Unknown", null],
    [null, null],
  ])("%s -> %s", (state, expected) => {
    expect(eventFromOverallState(state)).toBe(expected);
  });
});
