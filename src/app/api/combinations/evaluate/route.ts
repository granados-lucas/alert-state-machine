import { evaluateCombinations, recordEvaluatorRun } from "@/server/combination-evaluator";
import { errorResponse, json } from "@/server/http";
import { database, runAutomationsAfterResponse } from "@/server/runtime";

export const dynamic = "force-dynamic";

// Chamada pelo avaliador periódico (scripts/evaluate-combinations.mjs): reavalia todas as combinações,
// grava o heartbeat e executa as automações depois da resposta.
export async function POST() {
  try {
    const db = database();
    const { evaluated, changed, pending } = await evaluateCombinations(db);
    await recordEvaluatorRun(db);
    runAutomationsAfterResponse(db, pending);
    return json({ evaluated, changed });
  } catch (error) {
    return errorResponse(error);
  }
}
