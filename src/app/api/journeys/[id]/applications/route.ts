import { journeyApplicationsSchema, setJourneyApplications } from "@/server/journeys";
import { errorResponse, json, parseId, readJson, actorOf } from "@/server/http";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

// Substitui o conjunto de aplicações da jornada.
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = actorOf(request);
  const id = parseId((await ctx.params).id);
  if (id === null) return json({ error: "invalid id" }, 400);
  try {
    const { applications } = journeyApplicationsSchema.parse(await readJson(request));
    return json({ applications: await setJourneyApplications(database(), id, applications, auth.actor) });
  } catch (error) {
    return errorResponse(error);
  }
}
