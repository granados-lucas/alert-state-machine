import type { AlertState } from "@/domain/alert-machine";

export type FormValues = {
  provider: string;
  externalId: string;
  name: string;
  application: string;
  priority: string;
  tags: string;
  link: string;
  remediate: boolean;
  remediationName: string;
  mode: "webhook" | "api";
  url: string;
  method: string;
  headers: string;
  bodyTemplate: string;
  triggerStates: AlertState[];
  timeoutMs: string;
};

export const emptyValues: FormValues = {
  provider: "datadog",
  externalId: "",
  name: "",
  application: "",
  priority: "",
  tags: "",
  link: "",
  remediate: false,
  remediationName: "",
  mode: "webhook",
  url: "",
  method: "POST",
  headers: "",
  bodyTemplate: "",
  triggerStates: ["alert"],
  timeoutMs: "5000",
};

/** Converte o formulário no corpo de POST /api/alerts; a validação final é do servidor. */
export function buildCreatePayload(v: FormValues): { ok: true; body: unknown } | { ok: false; error: string } {
  let headers: unknown = {};
  if (v.remediate && v.headers.trim()) {
    try {
      headers = JSON.parse(v.headers);
    } catch {
      return { ok: false, error: 'Headers deve ser um JSON válido, por exemplo {"Authorization": "env:MEU_TOKEN"}.' };
    }
    if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
      return { ok: false, error: "Headers deve ser um objeto JSON." };
    }
  }
  const api = v.mode === "api";
  return {
    ok: true,
    body: {
      provider: v.provider,
      externalId: v.externalId.trim(),
      name: v.name.trim(),
      application: v.application.trim(),
      priority: v.priority ? Number(v.priority) : null,
      tags: v.tags.split(",").map((t) => t.trim()).filter(Boolean),
      link: v.link.trim() || null,
      remediations: v.remediate
        ? [
            {
              name: v.remediationName.trim() || "remediação",
              mode: v.mode,
              url: v.url.trim(),
              method: api ? v.method : "POST",
              headers,
              bodyTemplate: api && v.bodyTemplate.trim() ? v.bodyTemplate : null,
              triggerStates: v.triggerStates,
              timeoutMs: Number(v.timeoutMs) || 5000,
            },
          ]
        : [],
    },
  };
}
