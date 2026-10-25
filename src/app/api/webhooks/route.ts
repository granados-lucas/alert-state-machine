import { authenticateWebhook } from "@/providers/auth";
import { getProvider } from "@/providers";
import { sourceOf } from "@/providers/catalog";
import { ProviderPayloadError } from "@/providers/types";
import { getWebhookSecret } from "@/lib/env";
import { logger } from "@/lib/logger";
import { increment, observe } from "@/lib/metrics";
import { errorResponse, json, readJson } from "@/server/http";
import { ingestEvent } from "@/server/ingest";
import { runRemediations } from "@/server/remediation";
import { database, remediationDeps, runAfterResponse } from "@/server/runtime";

export const dynamic = "force-dynamic";

// Identificador de correlação: o do chamador (se for simples) ou um novo. Vai nos logs desta requisição e na resposta.
const REQUEST_ID = /^[\w.-]{1,64}$/;

// WEBHOOK ÚNICO: uma URL e um segredo para qualquer ferramenta. A fonte vem no corpo (`"source": "datadog"`), então trocar
// de ferramenta é mudar o modelo de payload dela, não a URL nem o segredo (o SNS, que não personaliza o corpo, é reconhecido
// pelo envelope). O provedor reentrega em 5xx (Datadog: até 5 vezes, timeout de 15 s; SNS: 5xx e 429): responder 4xx só
// para erros que reenviar não resolve (origem inválida, payload malformado) e 2xx para duplicatas.
export async function POST(request: Request) {
  const supplied = request.headers.get("x-request-id") ?? "";
  const requestId = REQUEST_ID.test(supplied) ? supplied : crypto.randomUUID();
  const started = performance.now();
  const source = { id: "unknown" as string }; // rótulo das métricas: só valores conhecidos, sem cardinalidade livre

  const [response, outcome] = await handle(request, logger.child({ requestId }), source);
  increment("webhook_requests_total", { provider: source.id, outcome });
  observe("webhook_duration_seconds", { provider: source.id }, (performance.now() - started) / 1000);
  response.headers.set("x-request-id", requestId);
  return response;
}

async function handle(request: Request, log: typeof logger, source: { id: string }): Promise<[Response, string]> {
  let secret: string | undefined;
  try {
    secret = getWebhookSecret();
  } catch {
    secret = undefined; // segredo inválido: webhook desligado
  }
  if (!authenticateWebhook(secret)(request.headers)) {
    log.warn("Webhook rejected: invalid credentials");
    return [json({ error: "unauthorized" }, 401), "unauthorized"];
  }
  try {
    const body = await readJson(request);
    const id = sourceOf(body);
    const provider = id ? getProvider(id) : undefined;
    if (!id || !provider) {
      log.warn("Webhook rejected: unknown source");
      return [json({ error: "unknown source" }, 400), "unknown_source"];
    }
    source.id = id;
    const handled = await provider.handshake?.(body);
    if (handled) {
      log.info({ source: id, message: handled.message }, "Webhook handshake handled");
      return [json({ status: "handshake", message: handled.message }), "handshake"];
    }
    const event = provider.parse(body);
    const db = database();
    const result = await ingestEvent(db, event);
    if (result.status === "duplicate") return [json({ status: "duplicate" }), "duplicate"];
    if (result.pending.length > 0) {
      runAfterResponse(() => runRemediations(db, result.pending, remediationDeps()));
    }
    log.info({ source: id, alertId: result.alertId, outcome: result.outcome, to: result.to }, "Webhook processed");
    return [json({ status: result.outcome, alertId: result.alertId, state: result.to }), result.outcome];
  } catch (error) {
    if (error instanceof ProviderPayloadError) {
      log.warn({ source: source.id, reason: error.message }, "Webhook rejected: invalid payload");
      return [json({ error: "invalid payload" }, 400), "invalid"];
    }
    const response = errorResponse(error);
    return [response, response.status >= 500 ? "error" : "rejected"];
  }
}
