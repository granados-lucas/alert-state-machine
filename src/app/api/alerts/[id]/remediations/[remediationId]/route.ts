import { updateRemediation, updateRemediationSchema } from "@/server/alerts";
import { errorResponse, json, parseId, readJson, actorOf } from "@/server/http";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string; remediationId: string }> }) {
  const auth = actorOf(request);
  const params = await ctx.params;
  const alertId = parseId(params.id);
  const remediationId = parseId(params.remediationId);
  if (alertId === null || remediationId === null) return json({ error: "invalid id" }, 400);
  try {
    const patch = updateRemediationSchema.parse(await readJson(request));
    return json(await updateRemediation(database(), alertId, remediationId, patch, auth.actor));
  } catch (error) {
    return errorResponse(error);
  }
}
