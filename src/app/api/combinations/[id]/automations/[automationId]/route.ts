import { updateAutomation, updateAutomationSchema } from "@/server/combination-automations";
import { actorOf, errorResponse, json, parseId, readJson } from "@/server/http";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string; automationId: string }> }) {
  const auth = actorOf(request);
  const params = await ctx.params;
  const combinationId = parseId(params.id);
  const automationId = parseId(params.automationId);
  if (combinationId === null || automationId === null) return json({ error: "invalid id" }, 400);
  try {
    const patch = updateAutomationSchema.parse(await readJson(request));
    return json(await updateAutomation(database(), combinationId, automationId, patch, auth.actor));
  } catch (error) {
    return errorResponse(error);
  }
}
