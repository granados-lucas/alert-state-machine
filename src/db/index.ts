import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getDatabaseUrl } from "@/lib/env";
import { logger } from "@/lib/logger";
import * as schema from "./schema";

const globals = globalThis as typeof globalThis & { __appPostgresPool?: Pool };
let cached: { client: Pool; db: NodePgDatabase<typeof schema> } | undefined;

export function getDb() {
  let client = globals.__appPostgresPool;
  if (!client) {
    client = new Pool({
      connectionString: getDatabaseUrl(),
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    client.on("error", (error) => {
      logger.error({ code: (error as NodeJS.ErrnoException).code }, "Idle database connection failed");
    });
    globals.__appPostgresPool = client;
  }
  // Keep the pool through HMR, but rebuild the ORM when its schema module reloads.
  if (!cached || cached.client !== client) cached = { client, db: drizzle({ client, schema }) };
  return cached.db;
}

/** Situação do pool (sem criá-lo): null enquanto ninguém usou o banco neste processo. */
export function poolStats() {
  const client = globals.__appPostgresPool;
  return client ? { total: client.totalCount, idle: client.idleCount, waiting: client.waitingCount } : null;
}

// Use only for owned shutdown/tests, never after each request.
export async function closeDatabase() {
  const client = globals.__appPostgresPool;
  delete globals.__appPostgresPool;
  cached = undefined;
  await client?.end();
}
