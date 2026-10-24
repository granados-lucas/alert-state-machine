import { z } from "zod";
import { ALERT_STATES } from "@/domain/alert-machine";
import { createAlert, createAlertSchema } from "@/server/alerts";
import { errorResponse, json, readJson, actorOf } from "@/server/http";
import { listAlerts } from "@/server/queries";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  state: z.enum(ALERT_STATES).optional(),
  application: z.string().max(100).optional(),
  search: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.coerce.number().int().positive().optional(),
});

export async function GET(request: Request) {
  try {
    const params = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return json(await listAlerts(database(), params));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const auth = actorOf(request);
  try {
    const input = createAlertSchema.parse(await readJson(request));
    return json(await createAlert(database(), input, auth.actor), 201);
  } catch (error) {
    return errorResponse(error);
  }
}
