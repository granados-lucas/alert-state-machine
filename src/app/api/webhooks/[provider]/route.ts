import { getProvider } from "@/providers";
import { PROVIDER_IDS } from "@/providers/catalog";
import { ProviderPayloadError } from "@/providers/types";
import { logger } from "@/lib/logger";
import { increment, observe } from "@/lib/metrics";
import { errorResponse, json, readJson } from "@/server/http";
import { ingestEvent } from "@/server/ingest";
import { runRemediations } from "@/server/remediation";
import { database, remediationDeps, runAfterResponse } from "@/server/runtime";

export const dynamic = "force-dynamic";

// Identificador de correlação: o do chamador (se for simples) ou um novo. Vai nos logs desta requisição e na resposta.
const REQUEST_ID = /^[\w.-]{1,64}$/;

// O provedor reentrega em 5xx (Datadog: até 5 vezes, timeout de 15 s; SNS: 5xx e 429): responder 4xx só para
// erros que reenviar não resolve (origem inválida, payload malformado) e 2xx para duplicatas.
// Cada fonte tem o seu adaptador e o seu segredo (src/providers).
export async function POST(request: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: providerId } = await ctx.params;
  const label = (PROVIDER_IDS as readonly string[]).includes(providerId) ? providerId : "unknown"; // sem cardinalidade livre
  const supplied = request.headers.get("x-request-id") ?? "";
  const requestId = REQUEST_ID.test(supplied) ? supplied : crypto.randomUUID();
  const log = logger.child({ requestId, provider: label });
  const started = performance.now();

  const [response, outcome] = await handle(request, providerId, log);
  increment("webhook_requests_total", { provider: label, outcome });
  observe("webhook_duration_seconds", { provider: label }, (performance.now() - started) / 1000);
  response.headers.set("x-request-id", requestId);
  return response;
}

async function handle(request: Request, providerId: string, log: typeof logger): Promise<[Response, string]> {
  const provider = getProvider(providerId);
  if (!provider) return [json({ error: "unknown provider" }, 404), "unknown_provider"];
  if (!provider.authenticate(request.headers)) {
    log.warn("Webhook rejected: invalid credentials");
    return [json({ error: "unauthorized" }, 401), "unauthorized"];
  }
  try {
    const body = await readJson(request);
    const handled = await provider.handshake?.(body);
    if (handled) {
      log.info({ message: handled.message }, "Webhook handshake handled");
      return [json({ status: "handshake", message: handled.message }), "handshake"];
    }
    const event = provider.parse(body);
    const db = database();
    const result = await ingestEvent(db, event);
    if (result.status === "duplicate") return [json({ status: "duplicate" }), "duplicate"];
    if (result.pending.length > 0) {
      runAfterResponse(() => runRemediations(db, result.pending, remediationDeps()));
    }
    log.info({ alertId: result.alertId, outcome: result.outcome, to: result.to }, "Webhook processed");
    return [json({ status: result.outcome, alertId: result.alertId, state: result.to }), result.outcome];
  } catch (error) {
    if (error instanceof ProviderPayloadError) {
      log.warn({ reason: error.message }, "Webhook rejected: invalid payload");
      return [json({ error: "invalid payload" }, 400), "invalid"];
    }
    const response = errorResponse(error);
    return [response, response.status >= 500 ? "error" : "rejected"];
  }
}
