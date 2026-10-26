import { timingSafeEqual } from "node:crypto";

const WEBHOOK_SECRET_HEADER = "x-webhook-secret";

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Autenticação do webhook único. Um segredo só (`WEBHOOK_SECRET`), aceito de duas formas:
 *  - cabeçalho `X-Webhook-Secret` (Datadog, AppDynamics, scripts);
 *  - HTTP Basic com o segredo como senha, o usuário é ignorado (o SNS só sabe autenticar assim: https://usuario:senha@host).
 * Sem segredo configurado, nega tudo.
 */
export const authenticateWebhook = (secret: string | undefined) => (headers: Headers) => {
  if (!secret) return false;
  const received = headers.get(WEBHOOK_SECRET_HEADER);
  if (received && safeEqual(received, secret)) return true;
  const basic = /^Basic\s+(\S+)$/i.exec(headers.get("authorization") ?? "");
  if (!basic) return false;
  const decoded = Buffer.from(basic[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator >= 0 && safeEqual(decoded.slice(separator + 1), secret);
};
