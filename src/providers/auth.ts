import { timingSafeEqual } from "node:crypto";

export const WEBHOOK_SECRET_HEADER = "x-webhook-secret";

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Segredo no cabeçalho X-Webhook-Secret (Datadog, AppDynamics, genérico). Sem segredo configurado, nega tudo. */
export const headerSecretAuth = (secret: string | undefined) => (headers: Headers) => {
  const received = headers.get(WEBHOOK_SECRET_HEADER);
  return Boolean(secret && received && safeEqual(received, secret));
};

/** HTTP Basic com o segredo como senha (o usuário é ignorado): o SNS só sabe autenticar assim (https://usuario:senha@host). */
export const basicPasswordAuth = (secret: string | undefined) => (headers: Headers) => {
  const match = /^Basic\s+(\S+)$/i.exec(headers.get("authorization") ?? "");
  if (!secret || !match) return false;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator >= 0 && safeEqual(decoded.slice(separator + 1), secret);
};
