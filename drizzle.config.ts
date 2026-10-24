import { loadEnvConfig } from "@next/env";
import { defineConfig } from "drizzle-kit";
import { databaseUrlSchema, parseEnv } from "./src/lib/env-schema";

loadEnvConfig(process.cwd());
const value = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  // SQL generation needs no connection; migration commands require a configured URL.
  ...(value ? { dbCredentials: { url: parseEnv("DATABASE_URL", value, databaseUrlSchema) } } : {}),
});
