import "server-only";
import { poolStats } from "@/db";
import { providerStatus } from "@/providers";
import { database } from "./runtime";
import { readTelemetry } from "./telemetry";

// Início deste processo (Next pode recarregar o módulo em dev; em produção o valor vale para o processo).
const globals = globalThis as typeof globalThis & { __appStartedAt?: Date };
export const startedAt = (globals.__appStartedAt ??= new Date());

export const uptimeMinutes = () => Math.round((Date.now() - startedAt.getTime()) / 60000);

/** Versão do pacote, gravada no build por next.config.ts. */
export const appVersion = () => process.env.APP_VERSION ?? "dev";

/** Telemetria com as dependências reais (banco, fontes configuradas, pool). Nunca lança: banco fora = `db.up` falso. */
export function currentTelemetry() {
  let db: ReturnType<typeof database> | undefined;
  try {
    db = database();
  } catch {
    db = undefined; // DATABASE_URL ausente ou inválida
  }
  return readTelemetry(db, { providers: providerStatus(), pool: poolStats() });
}
