import type { AlertState } from "./alert-machine";

// Gravidade crescente: um único alerta em "alert" deixa a aplicação (e a jornada) inteira vermelha.
const SEVERITY: Record<AlertState, number> = { ok: 0, no_data: 1, warn: 2, alert: 3 };

export type StateCounts = Record<AlertState, number>;

export const emptyCounts = (): StateCounts => ({ ok: 0, warn: 0, alert: 0, no_data: 0 });

// Sem alertas ativos não há estado (null): aparece neutro no mapa.
export function worstState(counts: Partial<Record<AlertState, number>>): AlertState | null {
  let worst: AlertState | null = null;
  for (const state of Object.keys(SEVERITY) as AlertState[]) {
    if ((counts[state] ?? 0) > 0 && (worst === null || SEVERITY[state] > SEVERITY[worst])) worst = state;
  }
  return worst;
}

/** Soma contagens (ex.: as aplicações de uma jornada). */
export function sumCounts(list: StateCounts[]): StateCounts {
  const total = emptyCounts();
  for (const counts of list) for (const state of Object.keys(total) as AlertState[]) total[state] += counts[state];
  return total;
}

/** Ordena do mais grave para o menos grave (alert primeiro, ok por último). */
export const bySeverityDesc = (a: AlertState | null, b: AlertState | null) => (b === null ? -1 : SEVERITY[b]) - (a === null ? -1 : SEVERITY[a]);
