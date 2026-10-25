import type { AlertState } from "@/domain/alert-machine";

/**
 * EQUIVALÊNCIA DE ESTADOS: alarme do CloudWatch (`NewStateValue`) -> estados da aplicação.
 * O CloudWatch só tem três estados e nenhum "aviso": ele não produz `warn`. Baseado na documentação
 * (OK, ALARM, INSUFFICIENT_DATA); nunca validado com um alarme real.
 */
export const ALARM_STATE_EQUIVALENCE: Record<string, { state: AlertState; reason: string }> = {
  OK: { state: "ok", reason: "O alarme está dentro do limite." },
  ALARM: { state: "alert", reason: "O limite foi ultrapassado." },
  INSUFFICIENT_DATA: { state: "no_data", reason: "Dados insuficientes para avaliar (falta de métrica ou alarme recém-criado)." },
};
