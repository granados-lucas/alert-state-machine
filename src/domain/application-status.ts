import type { AlertState } from "./alert-machine";

/**
 * Saúde de uma aplicação ou jornada a partir dos seus alertas ativos.
 *
 * PESO = PRIORIDADE do alerta (P1 a P5, no Datadog 1 é a mais alta). A escala é exponencial para que um
 * P1 pese mais que vários P5 juntos; alerta sem prioridade conta como P3 (meio da escala).
 *
 * Dois resultados, ambos derivados dos mesmos alertas:
 *  - COR (`status`): pior estado, com REBAIXAMENTO por prioridade: um alerta em "alert" só deixa o item
 *    vermelho se for P1 a P3; P4 e P5 em "alert" deixam âmbar (warn).
 *  - ÍNDICE (`health`, 0 a 100): média ponderada pelo peso; 100 = tudo saudável.
 */
export const PRIORITY_WEIGHTS: Record<number, number> = { 1: 16, 2: 8, 3: 4, 4: 2, 5: 1 };
export const DEFAULT_PRIORITY = 3;
/** Prioridade mais baixa (número mais alto) que ainda pode deixar um item vermelho. */
export const MAX_RED_PRIORITY = 3;

// Gravidade para ordenar e escolher o pior estado: um "alert" que conta vence tudo.
const SEVERITY: Record<AlertState, number> = { ok: 0, no_data: 1, warn: 2, alert: 3 };
// Quanto cada estado desconta do índice (no_data pesa pouco: não é falha comprovada).
const STATE_FACTOR: Record<AlertState, number> = { ok: 0, no_data: 0.25, warn: 0.5, alert: 1 };

export type StateCounts = Record<AlertState, number>;
/** Contagem de alertas ativos por estado e prioridade (null = sem prioridade). */
export type Bucket = { state: AlertState; priority: number | null; n: number };
export type Summary = {
  counts: StateCounts;
  total: number;
  /** Cor: pior estado já com o rebaixamento por prioridade. null = sem alertas. */
  status: AlertState | null;
  /** Índice de saúde ponderado (0 a 100). null = sem alertas. */
  health: number | null;
  /** Alertas em "alert" que não deixam vermelho por serem de baixa prioridade (P4/P5). */
  downgraded: number;
};

export const emptyCounts = (): StateCounts => ({ ok: 0, warn: 0, alert: 0, no_data: 0 });

const normalize = (priority: number | null) => (priority !== null && priority in PRIORITY_WEIGHTS ? priority : DEFAULT_PRIORITY);

export const weightOf = (priority: number | null) => PRIORITY_WEIGHTS[normalize(priority)];

/** Estado que conta para a cor: "alert" de prioridade baixa vira "warn". */
export const effectiveState = (state: AlertState, priority: number | null): AlertState =>
  state === "alert" && normalize(priority) > MAX_RED_PRIORITY ? "warn" : state;

export function summarize(buckets: Bucket[]): Summary {
  const counts = emptyCounts();
  let status: AlertState | null = null;
  let total = 0;
  let weight = 0;
  let loss = 0;
  let downgraded = 0;
  for (const { state, priority, n } of buckets) {
    if (n <= 0) continue;
    counts[state] += n;
    total += n;
    const effective = effectiveState(state, priority);
    if (effective !== state) downgraded += n;
    if (status === null || SEVERITY[effective] > SEVERITY[status]) status = effective;
    weight += weightOf(priority) * n;
    loss += weightOf(priority) * STATE_FACTOR[state] * n;
  }
  return { counts, total, status, health: total === 0 ? null : Math.round(100 * (1 - loss / weight)), downgraded };
}

/** Une listas de grupos (ex.: as aplicações de uma jornada) somando os iguais. */
export function mergeBuckets(lists: Bucket[][]): Bucket[] {
  const merged = new Map<string, Bucket>();
  for (const b of lists.flat()) {
    const key = `${b.state}:${b.priority ?? "none"}`;
    const hit = merged.get(key);
    if (hit) hit.n += b.n;
    else merged.set(key, { ...b });
  }
  return [...merged.values()];
}

/** Ordena do mais grave para o menos grave (alert primeiro, ok por último). */
export const bySeverityDesc = (a: AlertState | null, b: AlertState | null) => (b === null ? -1 : SEVERITY[b]) - (a === null ? -1 : SEVERITY[a]);

/** Ordena pior saúde primeiro (índice menor); sem índice vai para o fim. */
export const byHealthAsc = (a: number | null, b: number | null) => (a ?? 101) - (b ?? 101);
