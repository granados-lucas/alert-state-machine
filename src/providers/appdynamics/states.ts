import type { AlertState } from "@/domain/alert-machine";

/**
 * EQUIVALÊNCIA DE ESTADOS: tipo do evento da política do AppDynamics (`${latestEvent.eventType}`) -> estados.
 * A página de variáveis do AppDynamics lista como exemplos POLICY_OPEN_WARNING, POLICY_CONTINUES_WARNING,
 * POLICY_OPEN_CRITICAL, POLICY_CONTINUES_CRITICAL, POLICY_UPGRADED, POLICY_DOWNGRADED e POLICY_CLOSE_WARNING
 * ("podem não ser exaustivos"). Os demais fechamentos são SUPOSIÇÃO (ver `assumed`). Tipo desconhecido mantém o estado.
 */
export const EVENT_TYPE_EQUIVALENCE: Record<string, { state: AlertState; reason: string; assumed?: boolean }> = {
  POLICY_OPEN_WARNING: { state: "warn", reason: "Violação de aviso aberta." },
  POLICY_CONTINUES_WARNING: { state: "warn", reason: "A violação de aviso continua." },
  POLICY_OPEN_CRITICAL: { state: "alert", reason: "Violação crítica aberta." },
  POLICY_CONTINUES_CRITICAL: { state: "alert", reason: "A violação crítica continua." },
  POLICY_UPGRADED: { state: "alert", reason: "A violação subiu de aviso para crítica." },
  POLICY_DOWNGRADED: { state: "warn", reason: "A violação desceu de crítica para aviso." },
  POLICY_CLOSE_WARNING: { state: "ok", reason: "A violação de aviso terminou." },
  POLICY_CLOSE_CRITICAL: { state: "ok", reason: "A violação crítica terminou (nome não listado na documentação).", assumed: true },
  POLICY_CANCELED_WARNING: { state: "ok", reason: "A violação de aviso foi cancelada (nome não listado na documentação).", assumed: true },
  POLICY_CANCELED_CRITICAL: { state: "ok", reason: "A violação crítica foi cancelada (nome não listado na documentação).", assumed: true },
};
