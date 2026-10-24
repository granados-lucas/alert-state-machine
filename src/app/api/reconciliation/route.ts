import { z } from "zod";
import { actorOf, errorResponse, json, readJson } from "@/server/http";
import { executeReconciliation, listReconciliationRuns, reconcileOptionsSchema, startReconciliation } from "@/server/reconcile";
import { database, reconcileDeps, runAfterResponse } from "@/server/runtime";

export const dynamic = "force-dynamic";

const requestSchema = reconcileOptionsSchema.extend({ trigger: z.enum(["manual", "schedule"]).default("manual") });

export async function GET() {
  try {
    return json({ runs: await listReconciliationRuns(database(), 20) });
  } catch (error) {
    return errorResponse(error);
  }
}

// Inicia a reconciliação e responde 202 na hora: a leitura de centenas de monitores pode levar
// minutos (limite de uso do provedor). Acompanhe por GET /api/reconciliation/{id}.
export async function POST(request: Request) {
  const auth = actorOf(request);
  try {
    const { trigger, ...options } = requestSchema.parse(await readJson(request));
    const db = database();
    const deps = reconcileDeps(db);
    const run = await startReconciliation(db, options, auth.actor, trigger, deps);
    runAfterResponse(() => executeReconciliation(db, run.id, options, deps));
    return json({ id: run.id, status: run.status, dryRun: run.dryRun }, 202);
  } catch (error) {
    return errorResponse(error);
  }
}
