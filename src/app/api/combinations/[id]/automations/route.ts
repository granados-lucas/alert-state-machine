import { addAutomation, combinationAutomationSchema } from "@/server/combination-automations";
import { actorOf, errorResponse, json, parseId, readJson } from "@/server/http";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = actorOf(request);
  const id = parseId((await ctx.params).id);
  if (id === null) return json({ error: "invalid id" }, 400);
  try {
    const input = combinationAutomationSchema.parse(await readJson(request));
    return json(await addAutomation(database(), id, input, auth.actor), 201);
  } catch (error) {
    return errorResponse(error);
  }
}
