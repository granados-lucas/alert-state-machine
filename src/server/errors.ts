export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class ValidationError extends Error {}
/** Recurso desligado por falta de configuração (ex.: credenciais da API do provedor). */
export class NotConfiguredError extends Error {}
/** O provedor deste alerta não suporta a ação pedida. */
export class UnsupportedError extends Error {}

/** Violação de unicidade do PostgreSQL (23505), direta ou embrulhada pelo driver. */
export const isUniqueViolation = (error: unknown) => {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
};
