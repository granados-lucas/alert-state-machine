import { z } from "zod";

export const databaseUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return ["postgres:", "postgresql:"].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
});

export const logLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info");

export function parseEnv<T>(key: string, value: unknown, schema: z.ZodType<T>): T {
  const result = schema.safeParse(value);
  // Zod issues can include input values; expose only the variable name.
  if (!result.success) throw new Error(`Invalid or missing environment variable: ${key}`);
  return result.data;
}

// Segredos compartilhados: mínimo de 16 caracteres para barrar valores triviais.
export const secretSchema = z.string().min(16);

// "host" ou "host:porta", separados por vírgula; comparação em minúsculas.
export const hostListSchema = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );

// Sites da API do Datadog (docs.datadoghq.com/api/latest). Outro destino só pelo override explícito.
export const DATADOG_SITES = [
  "datadoghq.com",
  "us3.datadoghq.com",
  "us5.datadoghq.com",
  "datadoghq.eu",
  "ap1.datadoghq.com",
  "ap2.datadoghq.com",
  "uk1.datadoghq.com",
  "ddog-gov.com",
  "us2.ddog-gov.com",
] as const;
export const datadogSiteSchema = z.enum(DATADOG_SITES).default("datadoghq.com");

export const baseUrlSchema = z.url({ protocol: /^https?$/ });
export const apiCredentialSchema = z.string().trim().min(8).max(200);

// Nome do cabeçalho HTTP que o SSO na frente da aplicação preenche com a identidade de quem está agindo.
export const headerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,100}$/)
  .default("x-forwarded-email")
  .transform((value) => value.toLowerCase());
