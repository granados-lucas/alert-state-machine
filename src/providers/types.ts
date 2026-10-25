import type { AlertEvent } from "@/domain/alert-machine";

// Formato canônico: nada fora de src/providers conhece o payload de uma ferramenta específica.
export type NormalizedEvent = {
  provider: string;
  externalEventId: string;
  externalAlertId: string;
  alertName: string;
  application: string;
  // null = o provedor informou algo sem efeito na máquina (ex.: renotificação desconhecida).
  event: AlertEvent | null;
  occurredAt: Date;
  priority: number | null;
  tags: string[];
  link: string | null;
  raw: unknown;
};

/** Resposta de uma ação no monitor: o estado atual que o provedor informa, já como evento da máquina. */
export type MonitorSnapshot = { event: AlertEvent | null; rawState: string | null };

/** Ações que a aplicação executa no provedor (hoje: silenciar). Chamadas de saída: sempre com limite de tempo. */
export interface MonitorControl {
  mute(externalId: string, options: { until: Date; scope?: string }): Promise<MonitorSnapshot>;
  unmute(externalId: string, options: { scope?: string; allScopes?: boolean }): Promise<MonitorSnapshot>;
}

/** Monitor como o provedor o lista, já com a equivalência de estado aplicada pelo adaptador. */
export type ProviderMonitor = {
  externalId: string;
  name: string;
  /** Aplicação a que o monitor pertence (no Datadog, a tag service:). */
  application: string;
  /** Estado bruto do provedor (ex.: "Skipped"). */
  rawState: string | null;
  /** Evento que leva ao estado equivalente; null = o estado atual deve ser mantido. */
  event: AlertEvent | null;
  tags: string[];
  priority: number | null;
};

/** Cabeçalhos de limite de uso (Datadog: X-RateLimit-*). Valores ausentes ficam indefinidos. */
export type RateLimitInfo = { limit?: number; period?: number; remaining?: number; resetSeconds?: number; name?: string };

/** Leitura em lote dos monitores do provedor (reconciliação). */
export interface MonitorSource {
  listMonitors(options: { page: number; pageSize: number; tags?: string[] }): Promise<{ monitors: ProviderMonitor[]; rateLimit: RateLimitInfo }>;
}

export interface AlertProvider {
  readonly id: string;
  /**
   * Mensagens de protocolo que não são eventos (ex.: confirmação de assinatura do SNS). Devolve uma resposta
   * quando tratou a mensagem, ou null para seguir com `parse`. Roda depois de `authenticate`.
   */
  handshake?(body: unknown): Promise<{ message: string } | null>;
  /** Valida e normaliza o corpo; lança ProviderPayloadError se for inválido. */
  parse(body: unknown): NormalizedEvent;
  /** Presente só quando o provedor está configurado para receber ações (credenciais de API). */
  readonly control?: MonitorControl;
  /** Idem, para listar monitores (reconciliação). */
  readonly source?: MonitorSource;
}

export class ProviderPayloadError extends Error {}

/** Falha ao falar com a API do provedor. `status` é o HTTP recebido (null = sem resposta). */
export class ProviderApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

/** O provedor limitou o uso (HTTP 429): espere `resetSeconds` antes de tentar de novo. */
export class ProviderRateLimitError extends ProviderApiError {
  constructor(
    message: string,
    readonly rateLimit: RateLimitInfo,
  ) {
    super(message, 429);
  }
}
