// Oráculo independente: reimplementa as regras esperadas da máquina de estados.
const TRIGGERS = { hook: ["alert"], api: ["alert", "warn"], flaky: ["alert"] };
const SEVERITY = { ok: 0, no_data: 1, warn: 2, alert: 3 };
// Peso = prioridade (exponencial; sem prioridade conta como P3) e quanto cada estado desconta do índice.
const WEIGHTS = { 1: 16, 2: 8, 3: 4, 4: 2, 5: 1 };
const FACTOR = { ok: 0, no_data: 0.25, warn: 0.5, alert: 1 };

export function createModel(monitors) {
  const byId = new Map(
    monitors.map((m) => [m.monitorId, { monitor: m, state: "no_data", truth: "no_data", lastTs: null, transitions: 0, remediations: 0 }]),
  );
  return {
    get: (id) => byId.get(id),
    all: () => [...byId.values()],
    /** Retorna 'applied' | 'unchanged' | 'stale' como a aplicação principal deve responder. */
    apply(id, state, ts) {
      const m = byId.get(id);
      if (m.lastTs !== null && ts < m.lastTs) return "stale";
      m.lastTs = ts;
      m.truth = state; // evento entregue: o que o provedor tem e o que o app mostra coincidem
      if (m.state === state) return "unchanged";
      m.state = state;
      m.transitions += 1;
      const kind = m.monitor.remediation;
      if (kind && TRIGGERS[kind].includes(state)) m.remediations += 1;
      return "applied";
    },
    /** Mudança no provedor sem webhook (monitor silenciado): só a verdade do provedor muda. */
    silentChange(id, state) {
      byId.get(id).truth = state;
    },
    /** Cor e índice de saúde (peso = prioridade) de um conjunto de aplicações: reimplementação independente. */
    health(applicationNames) {
      const set = new Set(applicationNames);
      let status = null;
      let weight = 0;
      let loss = 0;
      let total = 0;
      for (const m of byId.values()) {
        if (!set.has(m.monitor.application)) continue;
        const p = m.monitor.priority ?? 3;
        const effective = m.state === "alert" && p > 3 ? "warn" : m.state;
        if (status === null || SEVERITY[effective] > SEVERITY[status]) status = effective;
        weight += WEIGHTS[p];
        loss += WEIGHTS[p] * FACTOR[m.state];
        total += 1;
      }
      return { status, health: total === 0 ? null : Math.round(100 * (1 - loss / weight)) };
    },
    journeyStatus(applicationNames) {
      return this.health(applicationNames).status;
    },
    applicationStatus(name) {
      return this.health([name]).status;
    },
  };
}
