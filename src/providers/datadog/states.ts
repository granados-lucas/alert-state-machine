import { eventTo, type AlertEvent, type AlertState } from "@/domain/alert-machine";

/**
 * EQUIVALÊNCIA DE ESTADOS: Datadog -> estados da aplicação. Fonte única: o webhook, o silêncio e a
 * reconciliação usam estas tabelas, e a tela /graph e docs/integrations/datadog.md as mostram.
 *
 * Os valores de `overall_state` vêm da documentação da API de monitores (enum fechado). O SIGNIFICADO
 * de Skipped, Ignored e Unknown não está nas páginas lidas: as linhas abaixo são decisões de produto
 * (ver `reason`) e devem ser confirmadas com quem opera os monitores.
 */
export type Equivalence = { state: AlertState; reason: string } | { state: null; reason: string };

export const OVERALL_STATE_EQUIVALENCE: Record<string, Equivalence> = {
  OK: { state: "ok", reason: "O monitor está saudável." },
  Warn: { state: "warn", reason: "Limiar de aviso ultrapassado." },
  Alert: { state: "alert", reason: "Limiar crítico ultrapassado." },
  "No Data": { state: "no_data", reason: "O monitor não recebe dados (condição própria do Datadog)." },
  Unknown: { state: "no_data", reason: "Sem avaliação ainda: a saúde é desconhecida, o mesmo significado de \"sem dados\" aqui." },
  Skipped: { state: null, reason: "Avaliação pulada: não informa saúde. O estado atual é mantido." },
  Ignored: { state: null, reason: "Ignorado pelo Datadog: não informa saúde. O estado atual é mantido." },
};

export type ResolvedState = {
  raw: string | null;
  /** Estado equivalente; null = não altera o estado (mantém o que já existe). */
  state: AlertState | null;
  reason: string;
  recognized: boolean;
};

export function resolveOverallState(raw: string | null): ResolvedState {
  const row = raw === null ? undefined : OVERALL_STATE_EQUIVALENCE[raw];
  if (!row) {
    return { raw, state: null, reason: raw === null ? "O provedor não informou o estado." : `Estado "${raw}" desconhecido: mantido.`, recognized: false };
  }
  return { raw, ...row, recognized: true };
}

/** Evento da máquina que leva ao estado equivalente (null quando o estado é mantido). */
export function eventFromOverallState(raw: string | null): AlertEvent | null {
  const { state } = resolveOverallState(raw);
  return state ? eventTo(state) : null;
}

// ---- Webhook: texto da transição ($ALERT_TRANSITION) e tipo ($ALERT_TYPE) -> evento
// Os textos "Warn" e "No Data" da transição são inferidos (a documentação só lista Triggered/Recovered/
// Re-Triggered); o `alert_type` serve de segurança.
export const TRANSITION_EQUIVALENCE: { contains: string; event: AlertEvent; note: string }[] = [
  { contains: "recover", event: "recovered", note: "Recovered" },
  { contains: "no data", event: "data_missing", note: "No Data" },
  { contains: "no_data", event: "data_missing", note: "No Data" },
  { contains: "warn", event: "warned", note: "Warn" },
  { contains: "trigger", event: "triggered", note: "Triggered / Re-Triggered" },
];

export const ALERT_TYPE_EQUIVALENCE: Record<string, AlertEvent> = { success: "recovered", warning: "warned", error: "triggered" };

export function mapTransition(transition: string, alertType: string): AlertEvent | null {
  const t = transition.toLowerCase();
  const hit = TRANSITION_EQUIVALENCE.find((row) => t.includes(row.contains));
  return hit ? hit.event : (ALERT_TYPE_EQUIVALENCE[alertType.toLowerCase()] ?? null);
}
