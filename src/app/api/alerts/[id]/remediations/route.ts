import { addRemediation } from "@/server/alerts";
import { errorResponse, json, parseId, readJson, actorOf } from "@/server/http";
import { remediationInputSchema } from "@/server/remediation";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = actorOf(request);
  const id = parseId((await ctx.params).id);
  if (id === null) return json({ error: "invalid id" }, 400);
  try {
    const input = remediationInputSchema.parse(await readJson(request));
    return json(await addRemediation(database(), id, input, auth.actor), 201);
  } catch (error) {
    return errorResponse(error);
  }
}
