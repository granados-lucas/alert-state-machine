import "server-only";
import { apiCredentialSchema, baseUrlSchema, databaseUrlSchema, datadogSiteSchema, headerNameSchema, hostListSchema, logLevelSchema, parseEnv, secretSchema } from "./env-schema";

export function getDatabaseUrl() {
  return parseEnv("DATABASE_URL", process.env.DATABASE_URL, databaseUrlSchema);
}

export function getLogLevel() {
  return parseEnv("LOG_LEVEL", process.env.LOG_LEVEL, logLevelSchema);
}

/** Segredo do webhook único (mín. 16 caracteres). Ausente = webhook desligado (responde 401 a tudo). */
export function getWebhookSecret() {
  return process.env.WEBHOOK_SECRET ? parseEnv("WEBHOOK_SECRET", process.env.WEBHOOK_SECRET, secretSchema) : undefined;
}

/** ARNs de tópico do SNS aceitos pelo CloudWatch (separados por vírgula). Vazio = qualquer tópico que conheça o segredo. */
export function getCloudwatchTopicArns() {
  return (process.env.CLOUDWATCH_TOPIC_ARNS ?? "").split(",").map((arn) => arn.trim()).filter(Boolean);
}

// Lista de destinos permitidos para remediação; vazia = nenhuma chamada de saída.
export function getRemediationAllowedHosts() {
  return parseEnv("REMEDIATION_ALLOWED_HOSTS", process.env.REMEDIATION_ALLOWED_HOSTS, hostListSchema);
}

export type DatadogApiConfig = { baseUrl: string; apiKey: string; appKey: string };

/**
 * Acesso à API do Datadog (silenciar monitores). Sem as duas chaves, o recurso fica desligado (undefined).
 * Destino: `https://api.<DD_SITE>`; `DD_API_BASE_URL` substitui isso (testes e simulador).
 */
export function getDatadogApiConfig(): DatadogApiConfig | undefined {
  if (!process.env.DD_API_KEY || !process.env.DD_APP_KEY) return undefined;
  const override = process.env.DD_API_BASE_URL;
  const baseUrl = override
    ? parseEnv("DD_API_BASE_URL", override, baseUrlSchema).replace(/\/+$/, "")
    : `https://api.${parseEnv("DD_SITE", process.env.DD_SITE || undefined, datadogSiteSchema)}`;
  return {
    baseUrl,
    apiKey: parseEnv("DD_API_KEY", process.env.DD_API_KEY, apiCredentialSchema),
    appKey: parseEnv("DD_APP_KEY", process.env.DD_APP_KEY, apiCredentialSchema),
  };
}

/** Cabeçalho com a identidade do usuário, preenchido pelo SSO corporativo (padrão `x-forwarded-email`). */
export function getAuthUserHeader() {
  return parseEnv("AUTH_USER_HEADER", process.env.AUTH_USER_HEADER || undefined, headerNameSchema);
}
