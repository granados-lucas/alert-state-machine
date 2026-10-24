import { getProvider } from "@/providers";
import { ProviderPayloadError } from "@/providers/types";
import { logger } from "@/lib/logger";
import { errorResponse, json, readJson } from "@/server/http";
import { ingestEvent } from "@/server/ingest";
import { runRemediations } from "@/server/remediation";
import { database, remediationDeps, runAfterResponse } from "@/server/runtime";

export const dynamic = "force-dynamic";

// O provedor reentrega em 5xx (Datadog: até 5 vezes, timeout de 15 s): responder 4xx só para
// erros que reenviar não resolve (origem inválida, payload malformado) e 2xx para duplicatas.
export async function POST(request: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: providerId } = await ctx.params;
  const provider = getProvider(providerId);
  if (!provider) return json({ error: "unknown provider" }, 404);
  if (!provider.authenticate(request.headers)) return json({ error: "unauthorized" }, 401);
  try {
    const event = provider.parse(await readJson(request));
    const db = database();
    const result = await ingestEvent(db, event);
    if (result.status === "duplicate") return json({ status: "duplicate" });
    if (result.pending.length > 0) {
      runAfterResponse(() => runRemediations(db, result.pending, remediationDeps()));
    }
    logger.info({ provider: providerId, alertId: result.alertId, outcome: result.outcome, to: result.to }, "Webhook processed");
    return json({ status: result.outcome, alertId: result.alertId, state: result.to });
  } catch (error) {
    if (error instanceof ProviderPayloadError) return json({ error: "invalid payload" }, 400);
    return errorResponse(error);
  }
}
