import { describe, expect, it, vi } from "vitest";
import { ProviderApiError, ProviderRateLimitError } from "../types";
import { createDatadogSource, readRateLimit } from "./source";

const config = { baseUrl: "https://api.datadoghq.com", apiKey: "api-key-12345", appKey: "app-key-12345" };
const page = (body: unknown, init: ResponseInit = { status: 200 }) => new Response(JSON.stringify(body), init);

describe("listMonitors", () => {
  it("chama GET /api/v1/monitor com página, tamanho, tags e as duas chaves", async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([]));
    await createDatadogSource(config, fetchMock).listMonitors({ page: 2, pageSize: 50, tags: ["service:checkout", "env:prod"] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.datadoghq.com/api/v1/monitor?page=2&page_size=50&monitor_tags=service%3Acheckout%2Cenv%3Aprod");
    expect(init).toMatchObject({ redirect: "manual", headers: { "DD-API-KEY": "api-key-12345", "DD-APPLICATION-KEY": "app-key-12345" } });
    expect(init.method).toBeUndefined(); // GET
  });

  it("aplica a equivalência de estado e deriva a aplicação das tags", async () => {
    const body = [
      { id: 1, name: "CPU", overall_state: "Alert", tags: ["service:checkout"], priority: 2 },
      { id: "2", name: "Mem", overall_state: "Unknown", tags: [] },
      { id: 3, name: "Disco", overall_state: "Skipped", tags: ["app:billing"], priority: null },
      { id: 4, overall_state: null },
    ];
    const { monitors } = await createDatadogSource(config, vi.fn().mockResolvedValue(page(body))).listMonitors({ page: 0, pageSize: 100 });
    expect(monitors).toEqual([
      { externalId: "1", name: "CPU", application: "checkout", rawState: "Alert", event: "triggered", tags: ["service:checkout"], priority: 2 },
      { externalId: "2", name: "Mem", application: "unassigned", rawState: "Unknown", event: "data_missing", tags: [], priority: null },
      { externalId: "3", name: "Disco", application: "billing", rawState: "Skipped", event: null, tags: ["app:billing"], priority: null },
      { externalId: "4", name: "monitor 4", application: "unassigned", rawState: null, event: null, tags: [], priority: null },
    ]);
  });

  it("lê os cabeçalhos X-RateLimit-*", async () => {
    const headers = { "x-ratelimit-limit": "60", "x-ratelimit-period": "3600", "x-ratelimit-remaining": "59", "x-ratelimit-reset": "120", "x-ratelimit-name": "monitors_read" };
    const { rateLimit } = await createDatadogSource(config, vi.fn().mockResolvedValue(page([], { status: 200, headers }))).listMonitors({ page: 0, pageSize: 10 });
    expect(rateLimit).toEqual({ limit: 60, period: 3600, remaining: 59, resetSeconds: 120, name: "monitors_read" });
    expect(readRateLimit(new Headers({ "x-ratelimit-remaining": "abc" }))).toEqual({ limit: undefined, period: undefined, remaining: undefined, resetSeconds: undefined, name: undefined });
  });

  it("429 vira ProviderRateLimitError com o tempo até o reset", async () => {
    const res = page({ errors: ["Rate limit"] }, { status: 429, headers: { "x-ratelimit-reset": "7", "x-ratelimit-period": "60" } });
    const error = await createDatadogSource(config, vi.fn().mockResolvedValue(res)).listMonitors({ page: 0, pageSize: 10 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toMatchObject({ status: 429, rateLimit: { resetSeconds: 7, period: 60 } });
  });

  it("traduz erros HTTP, corpo inesperado, rede e timeout sem expor URL ou chaves", async () => {
    const source = (res: Response | Error) =>
      createDatadogSource(config, vi.fn()[res instanceof Error ? "mockRejectedValue" : "mockResolvedValue"](res));
    const list = (s: ReturnType<typeof source>) => s.listMonitors({ page: 0, pageSize: 10 }).catch((e: unknown) => e as ProviderApiError);
    expect(await list(source(page({ errors: ["Forbidden"] }, { status: 403 })))).toMatchObject({ status: 403, message: "Datadog responded 403: Forbidden" });
    expect(await list(source(new Response("<html>", { status: 502 })))).toMatchObject({ status: 502, message: "Datadog responded 502" });
    expect(await list(source(page({ not: "an array" })))).toMatchObject({ message: "Datadog returned an unexpected monitor list" });
    expect(await list(source(new TypeError("fetch failed https://api.datadoghq.com/x?key=secret")))).toMatchObject({ status: null, message: "Datadog request failed (network error)" });
    expect(await list(source(Object.assign(new Error("x"), { name: "TimeoutError" })))).toMatchObject({ message: "Datadog request failed (timeout)" });
  });
});
