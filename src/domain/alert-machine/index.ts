// Fonte única de estados e transições: a lógica e o grafo leem esta mesma tabela.
// Estados e transições são premissas iniciais (ver PRODUCT.md, pendências).
export const ALERT_STATES = ["ok", "warn", "alert", "no_data"] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export const ALERT_EVENTS = ["recovered", "warned", "triggered", "data_missing"] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

const TARGET: Record<AlertEvent, AlertState> = {
  recovered: "ok",
  warned: "warn",
  triggered: "alert",
  data_missing: "no_data",
};

/** Evento que leva a um estado (inverso de TARGET): usado quando o provedor informa o estado, não a transição. */
export function eventTo(state: AlertState): AlertEvent {
  return ALERT_EVENTS.find((event) => TARGET[event] === state) as AlertEvent;
}

// Premissa: qualquer estado alcança qualquer outro. Restrições entram aqui, como dado.
export const TRANSITIONS: Record<AlertState, Partial<Record<AlertEvent, AlertState>>> = Object.fromEntries(
  ALERT_STATES.map((from) => [
    from,
    Object.fromEntries(ALERT_EVENTS.filter((e) => TARGET[e] !== from).map((e) => [e, TARGET[e]])),
  ]),
) as Record<AlertState, Partial<Record<AlertEvent, AlertState>>>;

export type TransitionResult =
  | { kind: "changed"; from: AlertState; to: AlertState; event: AlertEvent }
  | { kind: "unchanged"; state: AlertState }
  | { kind: "rejected"; state: AlertState; event: string };

export function transition(state: AlertState, event: AlertEvent): TransitionResult {
  const to = TRANSITIONS[state][event];
  if (to) return { kind: "changed", from: state, to, event };
  // Evento que leva ao estado atual (reentrega ou repetição) não é transição.
  if (TARGET[event] === state) return { kind: "unchanged", state };
  return { kind: "rejected", state, event };
}

// Arestas para o grafo.
export function listEdges() {
  return ALERT_STATES.flatMap((from) =>
    Object.entries(TRANSITIONS[from]).map(([event, to]) => ({ from, event: event as AlertEvent, to: to as AlertState })),
  );
}
