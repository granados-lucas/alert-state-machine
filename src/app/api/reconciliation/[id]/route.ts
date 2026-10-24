import { errorResponse, json, parseId } from "@/server/http";
import { getReconciliationRun } from "@/server/reconcile";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = parseId((await ctx.params).id);
  if (id === null) return json({ error: "invalid id" }, 400);
  try {
    return json(await getReconciliationRun(database(), id));
  } catch (error) {
    return errorResponse(error);
  }
}
