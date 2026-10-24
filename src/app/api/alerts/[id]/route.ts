import { updateAlert, updateAlertSchema } from "@/server/alerts";
import { errorResponse, json, parseId, readJson, actorOf } from "@/server/http";
import { getAlertDetail } from "@/server/queries";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, ctx: Context) {
  const id = parseId((await ctx.params).id);
  if (id === null) return json({ error: "invalid id" }, 400);
  try {
    const detail = await getAlertDetail(database(), id);
    return detail ? json(detail) : json({ error: "alert not found" }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, ctx: Context) {
  const auth = actorOf(request);
  const id = parseId((await ctx.params).id);
  if (id === null) return json({ error: "invalid id" }, 400);
  try {
    const patch = updateAlertSchema.parse(await readJson(request));
    return json(await updateAlert(database(), id, patch, auth.actor));
  } catch (error) {
    return errorResponse(error);
  }
}

// DELETE arquiva: o alerta sai das listagens e do mapa, mas o histórico permanece.
export async function DELETE(request: Request, ctx: Context) {
  const auth = actorOf(request);
  const id = parseId((await ctx.params).id);
  if (id === null) return json({ error: "invalid id" }, 400);
  try {
    return json(await updateAlert(database(), id, { archived: true }, auth.actor));
  } catch (error) {
    return errorResponse(error);
  }
}
