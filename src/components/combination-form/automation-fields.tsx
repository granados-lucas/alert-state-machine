"use client";

import type { ReactNode } from "react";
import { field } from "@/components/ui/ui";
import { cn } from "@/lib/utils";
import type { AutomationValues, TriggerState } from "./payload";

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm text-muted">
      {label}
      {children}
      {hint && <span className="text-xs">{hint}</span>}
    </label>
  );
}

const TRIGGERS: { state: TriggerState; label: string; hint: string; tone: string }[] = [
  { state: "alert", label: "Alerta", hint: "quando a combinação entra em alerta", tone: "border-alert/40 bg-alert/10 text-alert-fg" },
  { state: "ok", label: "Normal", hint: "quando ela volta ao normal", tone: "border-ok/30 bg-ok/10 text-ok" },
];

type Props = { values: AutomationValues; onChange: (values: AutomationValues) => void; showEnabled?: boolean };

/** Campos de uma automação (chamada ou webhook), usados ao criar a combinação e ao criar ou editar uma automação. */
export function AutomationFields({ values, onChange, showEnabled = false }: Props) {
  const set = <K extends keyof AutomationValues>(key: K, value: AutomationValues[K]) => onChange({ ...values, [key]: value });
  const toggle = (state: TriggerState) =>
    set("triggerStates", values.triggerStates.includes(state) ? values.triggerStates.filter((s) => s !== state) : [...values.triggerStates, state]);

  return (
    <div className="flex flex-col gap-4">
      <Field label="Nome da automação">
        <input className={field} value={values.name} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <Field label="Tipo">
        <select className={field} value={values.mode} onChange={(e) => set("mode", e.target.value as AutomationValues["mode"])}>
          <option value="webhook">Webhook (POST com o payload padrão)</option>
          <option value="api">API (método e corpo próprios)</option>
        </select>
      </Field>
      <Field label="URL de destino" hint="O host precisa estar em REMEDIATION_ALLOWED_HOSTS.">
        <input required type="url" className={field} value={values.url} onChange={(e) => set("url", e.target.value)} />
      </Field>
      {values.mode === "api" && (
        <>
          <Field label="Método">
            <select className={field} value={values.method} onChange={(e) => set("method", e.target.value)}>
              {["POST", "PUT", "PATCH", "GET", "DELETE"].map((m) => <option key={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Corpo (modelo)" hint={<>Variáveis: {"{{combination.name}}"}, {"{{combination.state}}"}, {"{{combination.previous_state}}"}, {"{{combination.components}}"}…</>}>
            <textarea rows={4} className={cn(field, "font-mono")} value={values.bodyTemplate} onChange={(e) => set("bodyTemplate", e.target.value)} />
          </Field>
        </>
      )}
      <Field label="Cabeçalhos (JSON)" hint={<>Segredos só como <code>env:NOME</code>.</>}>
        <textarea rows={3} className={cn(field, "font-mono")} value={values.headers} onChange={(e) => set("headers", e.target.value)} placeholder='{"Authorization": "env:MEU_TOKEN"}' />
      </Field>
      <fieldset className="flex flex-wrap gap-3 border-0 p-0">
        <legend className="mb-2 text-sm text-muted">Dispara</legend>
        {TRIGGERS.map((t) => (
          <label
            key={t.state}
            className={cn("flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm", values.triggerStates.includes(t.state) ? t.tone : "border-line text-muted")}
          >
            <input type="checkbox" className="size-4 accent-accent" checked={values.triggerStates.includes(t.state)} onChange={() => toggle(t.state)} />
            {t.label}
            <span className="text-xs opacity-80">({t.hint})</span>
          </label>
        ))}
      </fieldset>
      <Field label="Timeout (ms)">
        <input type="number" min={100} max={15000} className={field} value={values.timeoutMs} onChange={(e) => set("timeoutMs", e.target.value)} />
      </Field>
      {showEnabled && (
        <label className="flex cursor-pointer items-center gap-3 text-sm text-fg">
          <input type="checkbox" className="size-4 accent-accent" checked={values.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          Automação ativa
        </label>
      )}
    </div>
  );
}
