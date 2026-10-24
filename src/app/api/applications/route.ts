import { errorResponse, json } from "@/server/http";
import { getApplicationMap } from "@/server/queries";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json(await getApplicationMap(database()));
  } catch (error) {
    return errorResponse(error);
  }
}
