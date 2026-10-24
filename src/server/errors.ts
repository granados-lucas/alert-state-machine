export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class ValidationError extends Error {}
/** Recurso desligado por falta de configuração (ex.: credenciais da API do provedor). */
export class NotConfiguredError extends Error {}
/** O provedor deste alerta não suporta a ação pedida. */
export class UnsupportedError extends Error {}
