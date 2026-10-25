/**
 * Métricas da própria aplicação no formato de texto do Prometheus. Registro mínimo em memória (contadores e
 * histogramas por processo; zera ao reiniciar, como qualquer contador do Prometheus). O estado que vive no banco
 * (alertas por estado, silêncios pendentes, último evento por fonte) é medido na hora da coleta, ver
 * src/server/telemetry.ts. Sem dependências e sem rótulos de alta cardinalidade: nunca ID de alerta, nome ou usuário.
 */
type Labels = Record<string, string>;
type Kind = "counter" | "histogram";

const DEFINITIONS = {
  webhook_requests_total: { kind: "counter", help: "Webhooks recebidos, por fonte e resultado." },
  webhook_duration_seconds: { kind: "histogram", help: "Tempo de processamento do webhook, por fonte." },
  remediation_runs_total: { kind: "counter", help: "Execuções de remediação, por resultado." },
  mute_operations_total: { kind: "counter", help: "Operações de silenciar/reativar, por ação e resultado." },
  provider_api_requests_total: { kind: "counter", help: "Chamadas à API da fonte, por operação e resultado." },
  reconciliation_runs_total: { kind: "counter", help: "Execuções da reconciliação, por fonte e resultado." },
  reconciliation_duration_seconds: { kind: "histogram", help: "Duração da reconciliação, por fonte." },
  unhandled_errors_total: { kind: "counter", help: "Erros inesperados que viraram resposta 500." },
} as const satisfies Record<string, { kind: Kind; help: string }>;

export type MetricName = keyof typeof DEFINITIONS;
export const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
export const PREFIX = "global_alerts_";

type Series = { labels: Labels; value: number; buckets?: number[]; sum?: number };
type Store = Map<MetricName, Map<string, Series>>;

// Next pode carregar o módulo mais de uma vez (rotas, HMR): o registro fica em globalThis, como o pool do banco.
const globals = globalThis as typeof globalThis & { __appMetrics?: Store };
const store = (): Store => (globals.__appMetrics ??= new Map());

const keyOf = (labels: Labels) => JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));

function series(name: MetricName, labels: Labels): Series {
  const all = store().get(name) ?? new Map<string, Series>();
  store().set(name, all);
  const key = keyOf(labels);
  let entry = all.get(key);
  if (!entry) {
    entry = DEFINITIONS[name].kind === "histogram" ? { labels, value: 0, sum: 0, buckets: BUCKETS.map(() => 0) } : { labels, value: 0 };
    all.set(key, entry);
  }
  return entry;
}

export function increment(name: MetricName, labels: Labels = {}, by = 1) {
  series(name, labels).value += by;
}

export function observe(name: MetricName, labels: Labels, seconds: number) {
  const entry = series(name, labels);
  entry.value += 1; // contagem
  entry.sum = (entry.sum ?? 0) + seconds;
  BUCKETS.forEach((bound, i) => {
    if (seconds <= bound) (entry.buckets as number[])[i] += 1;
  });
}

/** Mede uma tarefa assíncrona (mesmo se falhar) e devolve o resultado dela. */
export async function timed<T>(name: MetricName, labels: Labels, task: () => Promise<T>) {
  const started = performance.now();
  try {
    return await task();
  } finally {
    observe(name, labels, (performance.now() - started) / 1000);
  }
}

export function resetMetrics() {
  store().clear();
}

/** Valor de uma série (para testes e para a tela de status). */
export function readMetric(name: MetricName, labels: Labels = {}) {
  return store().get(name)?.get(keyOf(labels))?.value ?? 0;
}

/** Medida calculada na hora da coleta (gauge): vem de fora do registro. */
export type Gauge = { name: string; help: string; samples: { labels?: Labels; value: number }[] };

const escapeValue = (value: string) => value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const fmt = (labels: Labels) => {
  const entries = Object.entries(labels);
  return entries.length ? `{${entries.map(([k, v]) => `${k}="${escapeValue(v)}"`).join(",")}}` : "";
};

export function renderPrometheus(gauges: Gauge[] = []) {
  const lines: string[] = [];
  for (const [name, definition] of Object.entries(DEFINITIONS) as [MetricName, (typeof DEFINITIONS)[MetricName]][]) {
    const full = PREFIX + name;
    lines.push(`# HELP ${full} ${definition.help}`, `# TYPE ${full} ${definition.kind}`);
    for (const s of store().get(name)?.values() ?? []) {
      if (definition.kind === "counter") {
        lines.push(`${full}${fmt(s.labels)} ${s.value}`);
        continue;
      }
      BUCKETS.forEach((bound, i) => lines.push(`${full}_bucket${fmt({ ...s.labels, le: String(bound) })} ${(s.buckets as number[])[i]}`));
      lines.push(`${full}_bucket${fmt({ ...s.labels, le: "+Inf" })} ${s.value}`, `${full}_sum${fmt(s.labels)} ${s.sum}`, `${full}_count${fmt(s.labels)} ${s.value}`);
    }
  }
  for (const gauge of gauges) {
    const full = PREFIX + gauge.name;
    lines.push(`# HELP ${full} ${gauge.help}`, `# TYPE ${full} gauge`);
    for (const sample of gauge.samples) lines.push(`${full}${fmt(sample.labels ?? {})} ${sample.value}`);
  }
  return `${lines.join("\n")}\n`;
}
