import { listCombinations } from "@/server/combination-queries";
import { createCombination, createCombinationSchema } from "@/server/combinations";
import { actorOf, errorResponse, json, readJson } from "@/server/http";
import { database, runAutomationsAfterResponse } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const includeArchived = new URL(request.url).searchParams.get("includeArchived") === "true";
    return json({ items: await listCombinations(database(), { includeArchived }) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const auth = actorOf(request);
  try {
    const input = createCombinationSchema.parse(await readJson(request));
    const db = database();
    const { combination, pending } = await createCombination(db, input, auth.actor);
    runAutomationsAfterResponse(db, pending);
    return json(combination, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
