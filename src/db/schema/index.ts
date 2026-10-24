import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { ALERT_STATES } from "@/domain/alert-machine";

const id = () => bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const fk = (name: string) => bigint(name, { mode: "number" });
const at = (name: string) => timestamp(name, { withTimezone: true });

export const alertState = pgEnum("alert_state", ALERT_STATES);
export const eventOutcome = pgEnum("event_outcome", ["applied", "unchanged", "stale", "ignored"]);
export const remediationMode = pgEnum("remediation_mode", ["webhook", "api"]);
export const runStatus = pgEnum("run_status", ["success", "failed", "skipped"]);
export const reconciliationStatus = pgEnum("reconciliation_status", ["running", "succeeded", "partial", "failed"]);
export const auditKind = pgEnum("audit_kind", [
  "alert_created",
  "alert_updated",
  "alert_archived",
  "state_changed",
  "remediation_created",
  "remediation_updated",
  "remediation_run",
  // Legado: valor de enum não pode ser removido do PostgreSQL; o recurso de dependências foi trocado por jornadas.
  "dependencies_updated",
  "journey_created",
  "journey_updated",
  "journey_applications_updated",
  "journey_deleted",
  "monitor_muted",
  "monitor_unmuted",
  "monitor_mute_failed",
  "reconciliation_run",
]);

export const applications = pgTable("applications", {
  id: id(),
  name: text().notNull().unique(),
  createdAt: at("created_at").notNull().defaultNow(),
});

// Jornada = fluxo de negócio que atravessa aplicações (ex.: "Compra"). Uma aplicação pode estar em
// várias jornadas; a saúde da jornada é o pior estado entre os alertas das aplicações dela.
export const journeys = pgTable("journeys", {
  id: id(),
  name: text().notNull().unique(),
  description: text(),
  createdAt: at("created_at").notNull().defaultNow(),
});

export const journeyApplications = pgTable(
  "journey_applications",
  {
    journeyId: fk("journey_id").notNull().references(() => journeys.id),
    applicationId: fk("application_id").notNull().references(() => applications.id),
  },
  (t) => [
    primaryKey({ columns: [t.journeyId, t.applicationId] }),
    index("journey_applications_application_id_idx").on(t.applicationId),
  ],
);

export const alerts = pgTable(
  "alerts",
  {
    id: id(),
    applicationId: fk("application_id").notNull().references(() => applications.id),
    provider: text().notNull(),
    externalId: text("external_id").notNull(),
    name: text().notNull(),
    // Todo alerta nasce em no_data (sem informação) até o primeiro evento.
    state: alertState().notNull().default("no_data"),
    priority: smallint(),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    link: text(),
    lastEventAt: at("last_event_at"),
    // Último estado bruto lido da API do provedor (ex.: "Skipped") e quando; ver a equivalência em docs.
    providerState: text("provider_state"),
    providerStateAt: at("provider_state_at"),
    stateChangedAt: at("state_changed_at").notNull().defaultNow(),
    archivedAt: at("archived_at"),
    // Silêncio aplicado no provedor por esta aplicação (vale até mutedUntil; o provedor encerra sozinho).
    mutedUntil: at("muted_until"),
    mutedScope: text("muted_scope"),
    muteReason: text("mute_reason"),
    mutedBy: text("muted_by"),
    mutedAt: at("muted_at"),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("alerts_provider_external_id_key").on(t.provider, t.externalId),
    // Alertas ativos por aplicação e estado: base do mapa e das listagens.
    index("alerts_application_state_idx").on(t.applicationId, t.state).where(sql`${t.archivedAt} is null`),
  ],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    provider: text().notNull(),
    externalEventId: text("external_event_id").notNull(),
    alertId: fk("alert_id").references(() => alerts.id),
    outcome: eventOutcome().notNull(),
    occurredAt: at("occurred_at").notNull(),
    receivedAt: at("received_at").notNull().defaultNow(),
    payload: jsonb().notNull(),
  },
  (t) => [
    // Idempotência: o provedor reentrega o mesmo evento em falhas 5xx.
    unique("webhook_events_provider_event_key").on(t.provider, t.externalEventId),
    index("webhook_events_alert_id_idx").on(t.alertId),
  ],
);

export const remediations = pgTable(
  "remediations",
  {
    id: id(),
    alertId: fk("alert_id").notNull().references(() => alerts.id),
    name: text().notNull(),
    mode: remediationMode().notNull(),
    url: text().notNull(),
    method: text().notNull().default("POST"),
    // Valores sensíveis só como referência "env:NOME"; nunca o segredo em si.
    headers: jsonb().$type<Record<string, string>>().notNull().default({}),
    bodyTemplate: text("body_template"),
    triggerStates: alertState("trigger_states").array().notNull().default(sql`'{alert}'::alert_state[]`),
    timeoutMs: integer("timeout_ms").notNull().default(5000),
    enabled: boolean().notNull().default(true),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("remediations_alert_id_idx").on(t.alertId),
    check("remediations_timeout_range", sql`${t.timeoutMs} between 100 and 15000`),
  ],
);

export const remediationRuns = pgTable(
  "remediation_runs",
  {
    id: id(),
    remediationId: fk("remediation_id").notNull().references(() => remediations.id),
    alertId: fk("alert_id").notNull().references(() => alerts.id),
    eventId: fk("event_id").references(() => webhookEvents.id),
    triggerState: alertState("trigger_state").notNull(),
    status: runStatus().notNull(),
    httpStatus: smallint("http_status"),
    durationMs: integer("duration_ms"),
    error: text(),
    at: at("at").notNull().defaultNow(),
  },
  (t) => [
    index("remediation_runs_alert_id_idx").on(t.alertId, t.at),
    index("remediation_runs_remediation_id_idx").on(t.remediationId),
    index("remediation_runs_event_id_idx").on(t.eventId),
  ],
);

// Somente inserção: um trigger (migração 0001) bloqueia UPDATE e DELETE.
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    at: at("at").notNull().defaultNow(),
    kind: auditKind().notNull(),
    actor: text().notNull(),
    alertId: fk("alert_id").references(() => alerts.id),
    applicationId: fk("application_id").references(() => applications.id),
    fromState: alertState("from_state"),
    toState: alertState("to_state"),
    eventId: fk("event_id").references(() => webhookEvents.id),
    details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index("audit_log_alert_id_idx").on(t.alertId, t.id),
    index("audit_log_application_id_idx").on(t.applicationId, t.id),
    index("audit_log_at_idx").on(t.at),
    index("audit_log_event_id_idx").on(t.eventId),
  ],
);

// Cada execução da reconciliação com o provedor. No máximo uma "running" por provedor (índice parcial).
export const reconciliationRuns = pgTable(
  "reconciliation_runs",
  {
    id: id(),
    provider: text().notNull(),
    trigger: text().notNull(),
    actor: text().notNull(),
    status: reconciliationStatus().notNull().default("running"),
    dryRun: boolean("dry_run").notNull().default(false),
    options: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    summary: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    // Últimos cabeçalhos X-RateLimit-* vistos (a documentação não publica números por endpoint).
    rateLimit: jsonb("rate_limit").$type<Record<string, unknown>>().notNull().default({}),
    error: text(),
    startedAt: at("started_at").notNull().defaultNow(),
    finishedAt: at("finished_at"),
  },
  (t) => [
    uniqueIndex("reconciliation_runs_one_running_idx").on(t.provider).where(sql`${t.status} = 'running'`),
    index("reconciliation_runs_started_at_idx").on(t.startedAt),
  ],
);

export type Alert = typeof alerts.$inferSelect;
export type Remediation = typeof remediations.$inferSelect;
