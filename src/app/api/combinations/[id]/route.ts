import { getCombination } from "@/server/combination-queries";
import { updateCombination, updateCombinationSchema } from "@/server/combinations";
import { actorOf, errorResponse, json, parseId, readJson } from "@/server/http";
import { database, runAutomationsAfterResponse } from "@/server/runtime";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: Context) {
  const id = parseId((await ctx.params).id);
  if (id === null) return json({ error: "invalid id" }, 400);
  try {
    const detail = await getCombination(database(), id);
    return detail ? json(detail) : json({ error: "combination not found" }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}

async function apply(request: Request, ctx: Context, read: (request: Request) => Promise<Parameters<typeof updateCombination>[2]>) {
  const auth = actorOf(request);
  const id = parseId((await ctx.params).id);
  if (id === null) return json({ error: "invalid id" }, 400);
  try {
    const db = database();
    const { combination, pending } = await updateCombination(db, id, await read(request), auth.actor);
    runAutomationsAfterResponse(db, pending);
    return json(combination);
  } catch (error) {
    return errorResponse(error);
  }
}

export const PATCH = (request: Request, ctx: Context) => apply(request, ctx, async (r) => updateCombinationSchema.parse(await readJson(r)));

// Arquivar: o histórico, as automações e a auditoria ficam.
export const DELETE = (request: Request, ctx: Context) => apply(request, ctx, async () => ({ archived: true }));
