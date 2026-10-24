import { ProviderApiError, type MonitorControl, type MonitorSnapshot } from "../types";
import { eventFromOverallState } from "./states";

export type DatadogApiConfig = { baseUrl: string; apiKey: string; appKey: string };

const TIMEOUT_MS = 10_000;

export { eventFromOverallState };

// Mensagem de erro do Datadog (`errors: string[]`), curta e sem chaves: só texto devolvido por ele.
function describeError(body: unknown) {
  const first = (body as { errors?: unknown } | null)?.errors;
  return Array.isArray(first) && typeof first[0] === "string" ? `: ${first[0].slice(0, 200)}` : "";
}

/**
 * Silenciar/reativar monitor pela API v1 (`POST /api/v1/monitor/{id}/mute|unmute`, permissão monitors_write).
 * Autenticação por cabeçalhos DD-API-KEY e DD-APPLICATION-KEY. Sem redirecionamento, com timeout.
 */
export function createDatadogControl(config: DatadogApiConfig, fetchImpl: typeof fetch = fetch): MonitorControl {
  async function post(externalId: string, action: "mute" | "unmute", query: Record<string, string>): Promise<MonitorSnapshot> {
    if (!/^\d{1,15}$/.test(externalId)) throw new ProviderApiError("monitor id is not a Datadog numeric id", null);
    const url = new URL(`${config.baseUrl}/api/v1/monitor/${externalId}/${action}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "DD-API-KEY": config.apiKey, "DD-APPLICATION-KEY": config.appKey, accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // Só o tipo do erro: mensagens de fetch podem conter a URL.
      const reason = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network error";
      throw new ProviderApiError(`Datadog request failed (${reason})`, null);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new ProviderApiError(`Datadog responded ${response.status}${describeError(body)}`, response.status);
    const raw = (body as { overall_state?: unknown } | null)?.overall_state;
    const rawState = typeof raw === "string" ? raw : null;
    return { rawState, event: eventFromOverallState(rawState) };
  }

  return {
    mute: (externalId, { until, scope }) =>
      post(externalId, "mute", { end: String(Math.floor(until.getTime() / 1000)), ...(scope ? { scope } : {}) }),
    unmute: (externalId, { scope, allScopes }) =>
      post(externalId, "unmute", { ...(scope ? { scope } : {}), ...(allScopes ? { all_scopes: "true" } : {}) }),
  };
}
