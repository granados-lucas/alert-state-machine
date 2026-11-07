import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgEnum, pgTable, primaryKey, smallint, text } from "drizzle-orm/pg-core";
import { COMBINATION_RULES, COMBINATION_STATES } from "@/domain/combination";
import { at, fk, id, remediationMode, runStatus } from "./common";
import { alerts } from "./index";

export const combinationRule = pgEnum("combination_rule", COMBINATION_RULES);
export const combinationState = pgEnum("combination_state", COMBINATION_STATES);

// Combinação: observa 1 a 20 alertas por uma regra e tem estado próprio. Não entra no cálculo de saúde.
export const combinations = pgTable(
  "combinations",
  {
    id: id(),
    name: text().notNull().unique(),
    description: text(),
    rule: combinationRule().notNull(),
    minCount: smallint("min_count"),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    state: combinationState().notNull().default("ok"),
    stateChangedAt: at("state_changed_at").notNull().defaultNow(),
    // Desde quando a regra vale sem interrupção (nulo em "ok").
    satisfiedSince: at("satisfied_since"),
    archivedAt: at("archived_at"),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("combinations_duration_range", sql`${t.durationSeconds} between 0 and 86400`),
    check(
      "combinations_min_count_rule",
      sql`(${t.rule} = 'at_least' and ${t.minCount} is not null and ${t.minCount} >= 1) or (${t.rule} <> 'at_least' and ${t.minCount} is null)`,
    ),
  ],
);

export const combinationAlerts = pgTable(
  "combination_alerts",
  {
    combinationId: fk("combination_id").notNull().references(() => combinations.id),
    alertId: fk("alert_id").notNull().references(() => alerts.id),
  },
  (t) => [primaryKey({ columns: [t.combinationId, t.alertId] }), index("combination_alerts_alert_id_idx").on(t.alertId)],
);

// Mesmo modelo da remediação do alerta, ligado à combinação; gatilhos só "alert" e "ok".
export const combinationAutomations = pgTable(
  "combination_automations",
  {
    id: id(),
    combinationId: fk("combination_id").notNull().references(() => combinations.id),
    name: text().notNull(),
    mode: remediationMode().notNull(),
    url: text().notNull(),
    method: text().notNull().default("POST"),
    // Valores sensíveis só como referência "env:NOME"; nunca o segredo em si.
    headers: jsonb().$type<Record<string, string>>().notNull().default({}),
    bodyTemplate: text("body_template"),
    triggerStates: combinationState("trigger_states").array().notNull().default(sql`'{alert}'::combination_state[]`),
    timeoutMs: integer("timeout_ms").notNull().default(5000),
    enabled: boolean().notNull().default(true),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("combination_automations_combination_id_idx").on(t.combinationId),
    check("combination_automations_timeout_range", sql`${t.timeoutMs} between 100 and 15000`),
    check("combination_automations_no_pending_trigger", sql`not ('pending' = any(${t.triggerStates}))`),
  ],
);

export const combinationAutomationRuns = pgTable(
  "combination_automation_runs",
  {
    id: id(),
    automationId: fk("automation_id").notNull().references(() => combinationAutomations.id),
    combinationId: fk("combination_id").notNull().references(() => combinations.id),
    triggerState: combinationState("trigger_state").notNull(),
    status: runStatus().notNull(),
    httpStatus: smallint("http_status"),
    durationMs: integer("duration_ms"),
    error: text(),
    at: at("at").notNull().defaultNow(),
  },
  (t) => [
    index("combination_automation_runs_combination_id_idx").on(t.combinationId, t.at),
    index("combination_automation_runs_automation_id_idx").on(t.automationId),
  ],
);

// Uma única linha: quando o avaliador periódico terminou o último ciclo (vale entre instâncias e reinícios).
export const combinationEvaluatorHeartbeat = pgTable(
  "combination_evaluator_heartbeat",
  {
    id: smallint().primaryKey().default(1),
    lastRunAt: at("last_run_at").notNull(),
  },
  (t) => [check("combination_evaluator_heartbeat_single_row", sql`${t.id} = 1`)],
);

export type Combination = typeof combinations.$inferSelect;
export type CombinationAutomation = typeof combinationAutomations.$inferSelect;
