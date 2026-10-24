import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { alerts, applications, auditLog, remediationRuns, remediations, type Remediation } from "@/db/schema";
import { ALERT_STATES, type AlertState } from "@/domain/alert-machine";
import type { Db } from "./db-types";

const SENSITIVE_HEADER = /authorization|token|secret|key|cookie|password/i;
const ENV_REF = /^env:[A-Z][A-Z0-9_]*$/;

// Segredos nunca ficam no banco: header sensível só aceita referência "env:NOME".
const headersSchema = z.record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string().max(2000)).superRefine((headers, ctx) => {
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER.test(name) && !ENV_REF.test(value)) {
      ctx.addIssue({ code: "custom", message: `header ${name} must use an env:NAME reference` });
    }
  }
});

export const remediationInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    mode: z.enum(["webhook", "api"]),
    url: z
      .url({ protocol: /^https?$/ })
      .refine((value) => {
        const u = new URL(value);
        return !u.username && !u.password;
      }, "credentials in URL are not allowed"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
    headers: headersSchema.default({}),
    bodyTemplate: z.string().max(4000).nullish(),
    triggerStates: z.array(z.enum(ALERT_STATES)).min(1).default(["alert"]),
    timeoutMs: z.number().int().min(100).max(15_000).default(5000),
    enabled: z.boolean().default(true),
  })
  .refine((v) => v.mode === "api" || (v.method === "POST" && !v.bodyTemplate), {
    message: "mode webhook always sends POST with the standard payload",
  });
export type RemediationInput = z.infer<typeof remediationInputSchema>;

export type PendingRemediation = { remediation: Remediation; state: AlertState; previousState: AlertState | null; eventId: number | null };

type AlertContext = {
  id: number;
  name: string;
  application: string;
  state: AlertState;
  previousState: AlertState | null;
  priority: number | null;
  tags: string[];
  link: string | null;
};

/** Destino permitido: host (qualquer porta) ou host:porta presente na lista. */
export function isAllowedDestination(url: URL, allowedHosts: string[]) {
  return allowedHosts.includes(url.host.toLowerCase()) || allowedHosts.includes(url.hostname.toLowerCase());
}

export function resolveHeaders(headers: Record<string, string>, env: Record<string, string | undefined>) {
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!ENV_REF.test(value)) {
      resolved[name] = value;
      continue;
    }
    const secret = env[value.slice(4)];
    if (!secret) throw new Error(`environment variable ${value.slice(4)} is not set`);
    resolved[name] = secret;
  }
  return resolved;
}

const escapeJson = (value: unknown) => JSON.stringify(String(value ?? "")).slice(1, -1);

/** Substitui {{alert.campo}} por valores escapados para JSON (o autor do modelo escreve as aspas). */
export function renderTemplate(template: string, ctx: AlertContext) {
  const values: Record<string, unknown> = {
    "alert.id": ctx.id,
    "alert.name": ctx.name,
    "alert.application": ctx.application,
    "alert.state": ctx.state,
    "alert.previous_state": ctx.previousState,
    "alert.priority": ctx.priority,
    "alert.link": ctx.link,
    "alert.tags": ctx.tags.join(","),
  };
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => escapeJson(values[key]));
}

function buildRequest(remediation: Remediation, ctx: AlertContext) {
  const hasBody = remediation.method !== "GET" && remediation.method !== "DELETE";
  if (!hasBody) return { body: undefined };
  if (remediation.mode === "api" && remediation.bodyTemplate) return { body: renderTemplate(remediation.bodyTemplate, ctx) };
  return {
    body: JSON.stringify({
      source: "global-alerts",
      alert: {
        id: ctx.id,
        name: ctx.name,
        application: ctx.application,
        state: ctx.state,
        previous_state: ctx.previousState,
        priority: ctx.priority,
        tags: ctx.tags,
        link: ctx.link,
      },
      firedAt: new Date().toISOString(),
    }),
  };
}

export type RemediationDeps = {
  fetch: typeof fetch;
  allowedHosts: string[];
  env: Record<string, string | undefined>;
};

type Outcome = { status: "success" | "failed" | "skipped"; httpStatus: number | null; durationMs: number | null; error: string | null };

async function execute(remediation: Remediation, ctx: AlertContext, deps: RemediationDeps): Promise<Outcome> {
  const url = new URL(remediation.url);
  if (!isAllowedDestination(url, deps.allowedHosts)) {
    return { status: "skipped", httpStatus: null, durationMs: null, error: "destination not in REMEDIATION_ALLOWED_HOSTS" };
  }
  const started = Date.now();
  try {
    const { body } = buildRequest(remediation, ctx);
    const response = await deps.fetch(url, {
      method: remediation.method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...resolveHeaders(remediation.headers, deps.env) },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(remediation.timeoutMs),
    });
    await response.body?.cancel();
    const ok = response.status >= 200 && response.status < 300;
    return {
      status: ok ? "success" : "failed",
      httpStatus: response.status,
      durationMs: Date.now() - started,
      error: ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    // Só o nome/código do erro: mensagens de fetch podem conter a URL ou credenciais.
    const reason = error instanceof Error ? (error.name === "TimeoutError" ? "timeout" : error.name) : "error";
    const detail = error instanceof Error && error.message.startsWith("environment variable") ? `: ${error.message}` : "";
    return { status: "failed", httpStatus: null, durationMs: Date.now() - started, error: `${reason}${detail}` };
  }
}

// Chamadas de saída lentas (ex.: DNS que não resolve) ocupam threads do libuv, que o driver do banco
// também usa. Limitar a concorrência evita que um destino ruim derrube o acesso ao banco.
const MAX_IN_FLIGHT = 4;
const MAX_QUEUED = 500;
let inFlight = 0;
const waiters: (() => void)[] = [];

async function withSlot<T>(task: () => Promise<T>): Promise<T | "queue-full"> {
  if (inFlight >= MAX_IN_FLIGHT) {
    if (waiters.length >= MAX_QUEUED) return "queue-full";
    await new Promise<void>((resolve) => waiters.push(resolve)); // o slot é repassado por quem termina
  } else {
    inFlight += 1;
  }
  try {
    return await task();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else inFlight -= 1;
  }
}

/** Executa as remediações pendentes depois do commit; cada execução é registrada em runs e na auditoria. */
export async function runRemediations(db: Db, pending: PendingRemediation[], deps: RemediationDeps) {
  await Promise.all(pending.map((item) => runOne(db, item, deps)));
}

async function runOne(db: Db, item: PendingRemediation, deps: RemediationDeps) {
  const [row] = await db
    .select({ id: alerts.id, name: alerts.name, priority: alerts.priority, tags: alerts.tags, link: alerts.link, application: applications.name })
    .from(alerts)
    .innerJoin(applications, eq(applications.id, alerts.applicationId))
    .where(eq(alerts.id, item.remediation.alertId));
  if (!row) return;
  const ctx: AlertContext = { ...row, state: item.state, previousState: item.previousState };
  const result = await withSlot(() => execute(item.remediation, ctx, deps));
  const outcome: Outcome =
    result === "queue-full" ? { status: "skipped", httpStatus: null, durationMs: null, error: "remediation queue full" } : result;
  await db.transaction(async (tx) => {
    await tx.insert(remediationRuns).values({
      remediationId: item.remediation.id,
      alertId: row.id,
      eventId: item.eventId,
      triggerState: item.state,
      ...outcome,
    });
    await tx.insert(auditLog).values({
      kind: "remediation_run",
      actor: "system:remediation",
      alertId: row.id,
      eventId: item.eventId,
      toState: item.state,
      details: { remediationId: item.remediation.id, name: item.remediation.name, ...outcome },
    });
  });
}

/** Remediações ativas do alerta que reagem ao novo estado. */
export async function findTriggered(db: Pick<Db, "select">, alertId: number, state: AlertState) {
  return db
    .select()
    .from(remediations)
    .where(and(eq(remediations.alertId, alertId), eq(remediations.enabled, true), sql`${state}::alert_state = any(${remediations.triggerStates})`));
}
