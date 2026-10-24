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

export interface AlertProvider {
  readonly id: string;
  /** Verifica a origem da requisição; falso = 401. */
  authenticate(headers: Headers): boolean;
  /** Valida e normaliza o corpo; lança ProviderPayloadError se for inválido. */
  parse(body: unknown): NormalizedEvent;
  /** Presente só quando o provedor está configurado para receber ações (credenciais de API). */
  readonly control?: MonitorControl;
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
