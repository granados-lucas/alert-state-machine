import "server-only";
import { after } from "next/server";
import { getDb } from "@/db";
import { getRemediationAllowedHosts } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getProvider } from "@/providers";
import type { ReconcileDeps } from "./reconcile";
import { runRemediations, type RemediationDeps } from "./remediation";

export const database = () => getDb();

export const remediationDeps = (): RemediationDeps => ({
  fetch,
  allowedHosts: getRemediationAllowedHosts(),
  env: process.env,
});

/** Dependências da reconciliação: provedores reais e remediações pelo mesmo caminho do webhook. */
export const reconcileDeps = (db: ReturnType<typeof getDb>): ReconcileDeps => ({
  getProvider,
  runRemediations: (pending) => runRemediations(db, pending, remediationDeps()),
});

/** Executa depois de responder (Next `after`); fora de uma requisição (testes, scripts) roda direto. */
export function runAfterResponse(task: () => Promise<unknown>) {
  const guarded = () =>
    task().catch((error: unknown) => logger.error({ err: error instanceof Error ? error.name : "unknown" }, "Background task failed"));
  try {
    after(guarded);
  } catch {
    void guarded();
  }
}
