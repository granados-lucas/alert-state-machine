import { ALERT_STATES, type AlertState } from "@/domain/alert-machine";
import { EVENT_TYPE_EQUIVALENCE } from "./appdynamics/states";
import { ALARM_STATE_EQUIVALENCE } from "./cloudwatch/states";
import { ALERT_TYPE_EQUIVALENCE, OVERALL_STATE_EQUIVALENCE, TRANSITION_EQUIVALENCE } from "./datadog/states";

/**
 * Catálogo das fontes de alertas: dados estáticos (sem ambiente, sem rede), lidos pela tela, pelos formulários
 * e pelos testes. Adicionar uma fonte = um adaptador em src/providers/<id>/, uma entrada aqui e uma em index.ts.
 */
export const PROVIDER_IDS = ["datadog", "cloudwatch", "appdynamics", "generic"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type EquivalenceRow = { raw: string; state: AlertState | null; reason: string };

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  /** Campo da fonte que carrega o estado (cabeçalho da tabela de equivalência). */
  sourceField: string;
  rows: EquivalenceRow[];
  notes: string[];
  /** Verificado contra um sistema real? Nenhum adaptador foi (ver docs/integrations). */
  validated: false;
};

const rowsOf = (table: Record<string, { state: AlertState | null; reason: string }>) =>
  Object.entries(table).map(([raw, row]) => ({ raw, state: row.state, reason: row.reason }));

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  datadog: {
    id: "datadog",
    label: "Datadog",
    sourceField: "overall_state (API)",
    rows: rowsOf(OVERALL_STATE_EQUIVALENCE),
    notes: [
      `Webhook: o texto da transição ($ALERT_TRANSITION) é reconhecido por ${TRANSITION_EQUIVALENCE.map((r) => `"${r.contains}" → ${r.event}`).join(", ")}; sem transição reconhecida vale o tipo ($ALERT_TYPE): ${Object.entries(ALERT_TYPE_EQUIVALENCE).map(([k, v]) => `${k} → ${v}`).join(", ")}.`,
    ],
    validated: false,
  },
  cloudwatch: {
    id: "cloudwatch",
    label: "Amazon CloudWatch",
    sourceField: "NewStateValue (alarme)",
    rows: rowsOf(ALARM_STATE_EQUIVALENCE),
    notes: ["O corpo do SNS não é personalizável, então não leva o campo source: o envelope é reconhecido. O CloudWatch não tem estado de aviso: nunca produz Aviso. A aplicação vem do texto service:nome na descrição do alarme e a prioridade de priority:N."],
    validated: false,
  },
  appdynamics: {
    id: "appdynamics",
    label: "AppDynamics",
    sourceField: "eventType (política)",
    rows: rowsOf(EVENT_TYPE_EQUIVALENCE),
    notes: ["Tipo de evento desconhecido mantém o estado atual. O AppDynamics não tem estado \"sem dados\" nas políticas; a prioridade é fixa no modelo da ação (um modelo por prioridade)."],
    validated: false,
  },
  generic: {
    id: "generic",
    label: "Genérico (JSON canônico)",
    sourceField: "state",
    rows: ALERT_STATES.map((state) => ({ raw: state, state, reason: "O estado informado é aplicado como está." })),
    notes: ["Para qualquer fonte sem adaptador: o remetente já informa o estado equivalente."],
    validated: false,
  },
};

/**
 * Qual fonte enviou o evento do webhook único: o campo `source` do corpo; sem ele, o envelope do SNS
 * (CloudWatch não deixa personalizar o corpo); sem nenhum dos dois, o formato genérico. Valor desconhecido: undefined.
 */
export function sourceOf(body: unknown): ProviderId | undefined {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (record.source === undefined) return typeof record.Type === "string" && typeof record.TopicArn === "string" ? "cloudwatch" : "generic";
  return (PROVIDER_IDS as readonly string[]).includes(record.source as string) ? (record.source as ProviderId) : undefined;
}

export const listProviderInfo = () => PROVIDER_IDS.map((id) => PROVIDERS[id]);

export const providerLabel = (id: string) => (id in PROVIDERS ? PROVIDERS[id as ProviderId].label : id);
