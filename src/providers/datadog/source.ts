import { z } from "zod";
import { ProviderApiError, ProviderRateLimitError, type MonitorSource, type ProviderMonitor, type RateLimitInfo } from "../types";
import type { DatadogApiConfig } from "./api";
import { applicationFromTags } from "./tags";
import { eventFromOverallState } from "./states";

const TIMEOUT_MS = 30_000;

const monitorSchema = z.object({
  id: z.union([z.number(), z.string()]).transform(String),
  name: z.string().default(""),
  overall_state: z.string().nullish(),
  tags: z.array(z.string()).default([]),
  priority: z.number().int().min(1).max(5).nullish(),
});

// Cabeçalhos documentados: X-RateLimit-Limit, -Period (s), -Remaining, -Reset (s até zerar), -Name.
export function readRateLimit(headers: Headers): RateLimitInfo {
  const num = (name: string) => {
    const value = headers.get(name);
    const parsed = value === null ? NaN : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    limit: num("x-ratelimit-limit"),
    period: num("x-ratelimit-period"),
    remaining: num("x-ratelimit-remaining"),
    resetSeconds: num("x-ratelimit-reset"),
    name: headers.get("x-ratelimit-name") ?? undefined,
  };
}

/**
 * Lista monitores com `GET /api/v1/monitor?page=&page_size=&monitor_tags=` (permissão monitors_read).
 * Páginas começam em 0 (suposição: a documentação lida não diz). 429 vira ProviderRateLimitError.
 */
export function createDatadogSource(config: DatadogApiConfig, fetchImpl: typeof fetch = fetch): MonitorSource {
  return {
    async listMonitors({ page, pageSize, tags }) {
      const url = new URL(`${config.baseUrl}/api/v1/monitor`);
      url.searchParams.set("page", String(page));
      url.searchParams.set("page_size", String(pageSize));
      if (tags?.length) url.searchParams.set("monitor_tags", tags.join(","));
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: { "DD-API-KEY": config.apiKey, "DD-APPLICATION-KEY": config.appKey, accept: "application/json" },
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        const reason = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network error";
        throw new ProviderApiError(`Datadog request failed (${reason})`, null);
      }
      const rateLimit = readRateLimit(response.headers);
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 429) throw new ProviderRateLimitError("Datadog rate limit reached (429)", rateLimit);
      if (!response.ok) {
        const first = (body as { errors?: unknown } | null)?.errors;
        throw new ProviderApiError(`Datadog responded ${response.status}${Array.isArray(first) && typeof first[0] === "string" ? `: ${first[0].slice(0, 200)}` : ""}`, response.status);
      }
      const parsed = z.array(monitorSchema).safeParse(body);
      if (!parsed.success) throw new ProviderApiError("Datadog returned an unexpected monitor list", response.status);
      const monitors: ProviderMonitor[] = parsed.data.map((m) => ({
        externalId: m.id,
        name: m.name || `monitor ${m.id}`,
        application: applicationFromTags(m.tags),
        rawState: m.overall_state ?? null,
        event: eventFromOverallState(m.overall_state ?? null),
        tags: m.tags,
        priority: m.priority ?? null,
      }));
      return { monitors, rateLimit };
    },
  };
}
