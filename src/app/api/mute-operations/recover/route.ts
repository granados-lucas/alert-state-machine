import { getProvider } from "@/providers";
import { errorResponse, json } from "@/server/http";
import { recoverMuteOperations } from "@/server/muting";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

// Reexecuta, agora, as operações de silêncio pendentes há mais de 1 minuto.
export async function POST() {
  try {
    return json(await recoverMuteOperations(database(), { getProvider }));
  } catch (error) {
    return errorResponse(error);
  }
}
