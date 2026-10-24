import { deleteJourney, updateJourney, updateJourneySchema } from "@/server/journeys";
import { errorResponse, json, parseId, readJson, actorOf } from "@/server/http";
import { getJourneyDetail } from "@/server/queries";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, ctx: Context) {
  const id = parseId((await ctx.params).id);
  if (id === null) return json({ error: "invalid id" }, 400);
  try {
    const detail = await getJourneyDetail(database(), id);
    return detail ? json(detail) : json({ error: "journey not found" }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, ctx: Context) {
  const auth = actorOf(request);
  const id = parseId((await ctx.params).id);
  if (id === null) return json({ error: "invalid id" }, 400);
  try {
    const patch = updateJourneySchema.parse(await readJson(request));
    return json(await updateJourney(database(), id, patch, auth.actor));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, ctx: Context) {
  const auth = actorOf(request);
  const id = parseId((await ctx.params).id);
  if (id === null) return json({ error: "invalid id" }, 400);
  try {
    await deleteJourney(database(), id, auth.actor);
    return json({ deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}
