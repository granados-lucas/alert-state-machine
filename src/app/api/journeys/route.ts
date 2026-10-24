import { createJourney, createJourneySchema } from "@/server/journeys";
import { errorResponse, json, readJson, actorOf } from "@/server/http";
import { getJourneyMap } from "@/server/queries";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json(await getJourneyMap(database()));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const auth = actorOf(request);
  try {
    const input = createJourneySchema.parse(await readJson(request));
    return json(await createJourney(database(), input, auth.actor), 201);
  } catch (error) {
    return errorResponse(error);
  }
}
