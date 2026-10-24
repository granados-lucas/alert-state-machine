import { getProvider } from "@/providers";
import { errorResponse, json, parseId, readJson, actorOf } from "@/server/http";
import { muteAlert, muteSchema } from "@/server/muting";
import { runRemediations } from "@/server/remediation";
import { database, remediationDeps, runAfterResponse } from "@/server/runtime";

export const dynamic = "force-dynamic";

// Silencia o monitor no provedor (com prazo obrigatório) e registra motivo e ator na auditoria.
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = actorOf(request);
  const id = parseId((await ctx.params).id);
  if (id === null) return json({ error: "invalid id" }, 400);
  try {
    const input = muteSchema.parse(await readJson(request));
    const db = database();
    const result = await muteAlert(db, id, input, auth.actor, { getProvider });
    // O estado informado pelo provedor pode ter mudado o alerta: remediações pendentes rodam depois da resposta.
    if (result.synced && result.synced.pending.length > 0) {
      const pending = result.synced.pending;
      runAfterResponse(() => runRemediations(db, pending, remediationDeps()));
    }
    return json({ ...result, synced: result.synced ? { outcome: result.synced.outcome, state: result.synced.to } : null });
  } catch (error) {
    return errorResponse(error);
  }
}
