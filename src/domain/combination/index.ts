// Regra e estado de uma combinação de alertas: funções puras, sem banco nem relógio.
export const COMBINATION_RULES = ["and", "or", "at_least"] as const;
export type CombinationRule = (typeof COMBINATION_RULES)[number];

// pending = regra satisfeita, mas a duração exigida ainda não se cumpriu.
export const COMBINATION_STATES = ["ok", "pending", "alert"] as const;
export type CombinationState = (typeof COMBINATION_STATES)[number];

export type RuleConfig = { rule: CombinationRule; minCount: number | null };

/** `alerting` componentes alertando, de `total` componentes. */
export function ruleMet({ rule, minCount }: RuleConfig, alerting: number, total: number) {
  if (rule === "and") return total >= 1 && alerting === total;
  if (rule === "or") return alerting >= 1;
  if (minCount === null) throw new Error("at_least requires minCount");
  return alerting >= minCount;
}

export type Step = { state: CombinationState; satisfiedSince: Date | null; changed: boolean };

/** Próximo estado dado se a regra vale agora e há quanto tempo vale (`satisfiedSince`). */
export function nextState(input: {
  state: CombinationState;
  satisfiedSince: Date | null;
  met: boolean;
  durationSeconds: number;
  now: Date;
}): Step {
  const { state, satisfiedSince, met, durationSeconds, now } = input;
  if (!met) return { state: "ok", satisfiedSince: null, changed: state !== "ok" };
  if (state === "alert") return { state, satisfiedSince, changed: false };
  const since = state === "pending" && satisfiedSince ? satisfiedSince : now;
  const elapsed = now.getTime() - since.getTime();
  if (elapsed >= durationSeconds * 1000) return { state: "alert", satisfiedSince: since, changed: true };
  return { state: "pending", satisfiedSince: since, changed: state !== "pending" };
}
