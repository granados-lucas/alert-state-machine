"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { btnPrimary, btnSecondary, Card } from "@/components/ui/ui";
import { cn } from "@/lib/utils";
import { AutomationFields } from "./automation-fields";
import { automationToValues, buildAutomationBody, emptyAutomation, type AutomationValues } from "./payload";

export type AutomationItem = {
  id: number;
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

const TRIGGER_LABEL: Record<string, string> = { alert: "Alerta", ok: "Normal" };

const errorsOf = (data: { error?: string; issues?: { path: string; message: string }[] }, status: number) =>
  data.issues ? data.issues.map((i) => `${i.path || "corpo"}: ${i.message}`) : [data.error ?? `Erro ${status}`];

/** Lista as automações da combinação e permite adicionar, editar e ativar/desativar. */
export function AutomationManager({ combinationId, automations }: { combinationId: number; automations: AutomationItem[] }) {
  const router = useRouter();
  // "new" = formulário de nova automação; número = edição daquela; null = fechado.
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [values, setValues] = useState<AutomationValues>(emptyAutomation);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, setPending] = useState(false);

  async function send(path: string, method: "POST" | "PATCH", body: unknown) {
    if (pending) return false;
    setPending(true);
    setErrors([]);
    try {
      const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setErrors(errorsOf(data, response.status));
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setErrors(["Não foi possível falar com o servidor."]);
      return false;
    } finally {
      setPending(false);
    }
  }

  const open = (target: number | "new", initial: AutomationValues) => {
    setErrors([]);
    setValues(initial);
    setEditing(target);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const payload = buildAutomationBody(values);
    if (!payload.ok) return setErrors([payload.error]);
    const path = editing === "new" ? `/api/combinations/${combinationId}/automations` : `/api/combinations/${combinationId}/automations/${editing}`;
    if (await send(path, editing === "new" ? "POST" : "PATCH", payload.body)) setEditing(null);
  }

  const toggle = (a: AutomationItem) => send(`/api/combinations/${combinationId}/automations/${a.id}`, "PATCH", { enabled: !a.enabled });

  return (
    <div className="flex flex-col gap-3">
      {automations.length === 0 && editing !== "new" && <p className="text-sm text-muted">Nenhuma automação configurada.</p>}
      <ul className="grid gap-3 lg:grid-cols-2">
        {automations.map((a) => (
          <li key={a.id} className="rounded-2xl border border-line bg-surface p-4 text-sm">
            <p className="flex items-center justify-between gap-2">
              <strong className="text-fg">{a.name}</strong>
              <span className={cn("rounded-md border px-2 py-0.5 text-xs", a.enabled ? "border-ok/30 bg-ok/10 text-ok" : "border-line text-muted")}>{a.enabled ? "Ativa" : "Desativada"}</span>
            </p>
            <p className="mt-1 text-muted">{a.mode === "webhook" ? "Webhook" : `API ${a.method}`} para <code className="break-all font-mono text-xs text-fg">{a.url}</code></p>
            <p className="mt-2 text-xs text-muted">Dispara em: {a.triggerStates.map((s) => TRIGGER_LABEL[s] ?? s).join(", ")} · timeout {a.timeoutMs} ms</p>
            <div className="mt-3 flex gap-2">
              <button type="button" className={btnSecondary} disabled={pending} onClick={() => void toggle(a)}>{a.enabled ? "Desativar" : "Ativar"}</button>
              <button type="button" className={btnSecondary} disabled={pending} onClick={() => open(a.id, automationToValues(a))}>Editar</button>
            </div>
          </li>
        ))}
      </ul>

      {editing === null ? (
        <div><button type="button" className={btnSecondary} onClick={() => open("new", emptyAutomation)}>Adicionar automação</button></div>
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <Card className="flex flex-col gap-4">
            <h3 className="text-base font-semibold text-fg">{editing === "new" ? "Nova automação" : "Editar automação"}</h3>
            <AutomationFields values={values} onChange={setValues} showEnabled />
            {errors.length > 0 && (
              <ul role="alert" className="list-disc rounded-2xl border border-alert/40 bg-alert/10 p-4 pl-8 text-sm text-alert-fg">
                {errors.map((e) => <li key={e}>{e}</li>)}
              </ul>
            )}
            <div className="flex gap-2">
              <button type="submit" disabled={pending} className={btnPrimary}>{pending ? "Salvando…" : "Salvar"}</button>
              <button type="button" className={btnSecondary} disabled={pending} onClick={() => setEditing(null)}>Cancelar</button>
            </div>
          </Card>
        </form>
      )}
      {editing === null && errors.length > 0 && (
        <ul role="alert" className="list-disc rounded-2xl border border-alert/40 bg-alert/10 p-4 pl-8 text-sm text-alert-fg">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
    </div>
  );
}
