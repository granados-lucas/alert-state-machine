// Oráculo independente: reimplementa as regras esperadas da máquina de estados.
const TRIGGERS = { hook: ["alert"], api: ["alert", "warn"], flaky: ["alert"] };
const SEVERITY = { ok: 0, no_data: 1, warn: 2, alert: 3 };

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
    /** Saúde da jornada = pior estado entre as aplicações dela. */
    journeyStatus(applicationNames) {
      return applicationNames.reduce((worst, name) => {
        const s = this.applicationStatus(name);
        return s !== null && (worst === null || SEVERITY[s] > SEVERITY[worst]) ? s : worst;
      }, null);
    },
    applicationStatus(name) {
      const states = [...byId.values()].filter((m) => m.monitor.application === name).map((m) => m.state);
      return states.reduce((worst, s) => (worst === null || SEVERITY[s] > SEVERITY[worst] ? s : worst), null);
    },
  };
}
