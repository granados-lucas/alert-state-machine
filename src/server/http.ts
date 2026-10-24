import { ZodError } from "zod";
import { getAuthUserHeader } from "@/lib/env";
import { logger } from "@/lib/logger";
import { ProviderApiError } from "@/providers/types";
import { ConflictError, NotConfiguredError, NotFoundError, UnsupportedError, ValidationError } from "./errors";

export const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * Quem está agindo. A autenticação é do SSO corporativo na frente da aplicação, que preenche o
 * cabeçalho AUTH_USER_HEADER; aqui só lemos a identidade para a auditoria. A aplicação NÃO pode ficar
 * acessível sem passar pelo SSO: qualquer cliente que alcançá-la diretamente escolhe o próprio nome.
 */
export function actorOf(request: Request): { actor: string } {
  const value = request.headers.get(getAuthUserHeader())?.trim().slice(0, 100);
  return { actor: value || "anonymous" };
}

export class PayloadTooLargeError extends Error {}

/** Lê o corpo JSON com limite de tamanho; lança SyntaxError se não for JSON. */
export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new PayloadTooLargeError();
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new PayloadTooLargeError();
  return JSON.parse(text);
}

/** Converte erros conhecidos em respostas; o resto vira 500 sem detalhes internos. */
export function errorResponse(error: unknown): Response {
  if (error instanceof ZodError) return json({ error: "validation failed", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  if (error instanceof SyntaxError) return json({ error: "invalid JSON" }, 400);
  if (error instanceof PayloadTooLargeError) return json({ error: "payload too large" }, 413);
  if (error instanceof ValidationError) return json({ error: error.message }, 400);
  if (error instanceof NotFoundError) return json({ error: error.message }, 404);
  if (error instanceof ConflictError) return json({ error: error.message }, 409);
  if (error instanceof NotConfiguredError) return json({ error: error.message }, 503);
  if (error instanceof UnsupportedError) return json({ error: error.message }, 501);
  // Falha do provedor (credencial inválida, limite, indisponível): 404 só se o monitor não existe; o resto é 502.
  if (error instanceof ProviderApiError) return json({ error: error.message }, error.status === 404 ? 404 : 502);
  // Nome, código do Postgres e mensagem curta bastam para diagnosticar; `detail` do driver (com valores) fica de fora.
  const info = error instanceof Error ? { err: error.name, code: (error as { code?: string }).code, reason: error.message.slice(0, 200) } : { err: "unknown" };
  logger.error(info, "Unhandled request error");
  return json({ error: "internal error" }, 500);
}

export function parseId(value: string): number | null {
  return /^\d{1,15}$/.test(value) ? Number(value) : null;
}
