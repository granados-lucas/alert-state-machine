import { errorResponse, json } from "@/server/http";
import { listPendingMuteOperations } from "@/server/muting";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

// Operações de silêncio ainda sem desfecho gravado (a recuperação as conclui).
export async function GET() {
  try {
    return json({ pending: await listPendingMuteOperations(database()) });
  } catch (error) {
    return errorResponse(error);
  }
}
