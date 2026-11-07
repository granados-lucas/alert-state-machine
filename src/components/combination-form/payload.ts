import type { CombinationRule } from "@/domain/combination";

export type TriggerState = "alert" | "ok";

export type AutomationValues = {
  name: string;
  mode: "webhook" | "api";
  url: string;
  method: string;
  headers: string;
  bodyTemplate: string;
  triggerStates: TriggerState[];
  timeoutMs: string;
  enabled: boolean;
};

export const emptyAutomation: AutomationValues = {
  name: "",
  mode: "webhook",
  url: "",
  method: "POST",
  headers: "",
  bodyTemplate: "",
  triggerStates: ["alert"],
  timeoutMs: "5000",
  enabled: true,
};

type Result = { ok: true; body: unknown } | { ok: false; error: string };

/** Corpo de POST/PATCH das automações; a validação final é do servidor. */
export function buildAutomationBody(v: AutomationValues): Result {
  let headers: unknown = {};
  if (v.headers.trim()) {
    try {
      headers = JSON.parse(v.headers);
    } catch {
      return { ok: false, error: 'Cabeçalhos deve ser um JSON válido, por exemplo {"Authorization": "env:MEU_TOKEN"}.' };
    }
    if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return { ok: false, error: "Cabeçalhos deve ser um objeto JSON." };
  }
  if (v.triggerStates.length === 0) return { ok: false, error: "Escolha em que momento a automação dispara (Alerta e/ou Normal)." };
  const api = v.mode === "api";
  return {
    ok: true,
    body: {
      name: v.name.trim() || "automação",
      mode: v.mode,
      url: v.url.trim(),
      method: api ? v.method : "POST",
      headers,
      bodyTemplate: api && v.bodyTemplate.trim() ? v.bodyTemplate : null,
      triggerStates: v.triggerStates,
      timeoutMs: Number(v.timeoutMs) || 5000,
      enabled: v.enabled,
    },
  };
}

type StoredAutomation = {
  name: string;
  mode: "webhook" | "api";
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyTemplate: string | null;
  triggerStates: string[];
  timeoutMs: number;
  enabled: boolean;
};

/** Preenche o formulário de edição com a automação gravada. */
export function automationToValues(a: StoredAutomation): AutomationValues {
  return {
    name: a.name,
    mode: a.mode,
    url: a.url,
    method: a.method,
    headers: Object.keys(a.headers).length > 0 ? JSON.stringify(a.headers, null, 2) : "",
    bodyTemplate: a.bodyTemplate ?? "",
    triggerStates: a.triggerStates.filter((s): s is TriggerState => s === "alert" || s === "ok"),
    timeoutMs: String(a.timeoutMs),
    enabled: a.enabled,
  };
}

export type CombinationValues = {
  name: string;
  description: string;
  rule: CombinationRule;
  minCount: string;
  /** A tela trabalha em minutos; a API, em segundos. */
  minutes: string;
  alertIds: number[];
  addAutomation: boolean;
  automation: AutomationValues;
};

export const emptyCombination: CombinationValues = {
  name: "",
  description: "",
  rule: "and",
  minCount: "2",
  minutes: "0",
  alertIds: [],
  addAutomation: false,
  automation: emptyAutomation,
};

/** Corpo de POST (criar, com a automação opcional) ou PATCH (editar, só a combinação) de /api/combinations. */
export function buildCombinationPayload(v: CombinationValues, mode: "create" | "edit"): Result {
  if (v.alertIds.length === 0) return { ok: false, error: "Escolha pelo menos um alerta." };
  const minutes = Number(v.minutes || 0);
  if (!Number.isFinite(minutes) || minutes < 0) return { ok: false, error: "A duração precisa ser zero ou mais minutos." };
  const atLeast = v.rule === "at_least";
  const minCount = Number(v.minCount);
  if (atLeast && (!Number.isInteger(minCount) || minCount < 1)) return { ok: false, error: "Informe quantos alertas, no mínimo (1 ou mais)." };
  const body: Record<string, unknown> = {
    name: v.name.trim(),
    description: v.description.trim() || null,
    rule: v.rule,
    minCount: atLeast ? minCount : null,
    durationSeconds: Math.round(minutes * 60),
    alertIds: v.alertIds,
  };
  if (mode === "create") {
    if (v.addAutomation) {
      const automation = buildAutomationBody(v.automation);
      if (!automation.ok) return automation;
      body.automations = [automation.body];
    } else {
      body.automations = [];
    }
  }
  return { ok: true, body };
}

export function formatDuration(seconds: number) {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 === 0 ? `${minutes} min` : `${minutes} min ${seconds % 60} s`;
}

/** "E · 2 min", "OU", "Pelo menos 2 de 3 · 5 min". */
export function describeRule(c: { rule: CombinationRule; minCount: number | null; durationSeconds: number }, total: number) {
  const base = c.rule === "and" ? "E" : c.rule === "or" ? "OU" : `Pelo menos ${c.minCount} de ${total}`;
  return c.durationSeconds > 0 ? `${base} · ${formatDuration(c.durationSeconds)}` : base;
}
