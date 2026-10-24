import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Db } from "@/server/db-types";

// PostgreSQL embutido (PGlite) com as migrações reais: testa SQL e triggers sem servidor.
// Não substitui um teste contra o PostgreSQL do docker compose (ver docs/quality.md).
export async function createTestDb() {
  const client = new PGlite();
  const orm = drizzle({ client, schema });
  await migrate(orm, { migrationsFolder: "./drizzle" });
  return { db: orm as unknown as Db, close: () => client.close() };
}
