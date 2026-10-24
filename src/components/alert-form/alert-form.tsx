"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ALERT_STATES } from "@/domain/alert-machine";
import { STATE_META } from "@/components/alert-graph/meta";
import { btnPrimary, Card, field } from "@/components/ui/ui";
import { cn } from "@/lib/utils";
import { buildCreatePayload, emptyValues, type FormValues } from "./payload";

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm text-muted">
      {label}
      {children}
      {hint && <span className="text-xs">{hint}</span>}
    </label>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-4 border-0 p-0">
      <legend className="mb-3 text-base font-semibold text-fg">{title}</legend>
      {children}
    </fieldset>
  );
}

export function AlertForm() {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(emptyValues);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const payload = buildCreatePayload(values);
    if (!payload.ok) return setErrors([payload.error]);
    setPending(true);
    setErrors([]);
    try {
      const response = await fetch("/api/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload.body),
      });
      const data = await response.json();
      if (response.ok) return router.push(`/alerts/${data.id}`);
      setErrors(
        data.issues
          ? data.issues.map((i: { path: string; message: string }) => `${i.path || "corpo"}: ${i.message}`)
          : [data.error ?? `Erro ${response.status}`],
      );
    } catch {
      setErrors(["Não foi possível falar com o servidor."]);
    } finally {
      setPending(false);
    }
  }

  const toggleState = (state: (typeof ALERT_STATES)[number]) =>
    set("triggerStates", values.triggerStates.includes(state) ? values.triggerStates.filter((s) => s !== state) : [...values.triggerStates, state]);

  return (
    <form onSubmit={(e) => void submit(e)}>
      <Card className="flex flex-col gap-8 p-6">
        <Group title="Informações básicas">
          <Field label="ID do monitor no provedor (Datadog)">
            <input required className={field} value={values.externalId} onChange={(e) => set("externalId", e.target.value)} />
          </Field>
          <Field label="Nome">
            <input required className={field} value={values.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Aplicação" hint="Mesmo valor da tag service: do monitor.">
            <input required className={field} value={values.application} onChange={(e) => set("application", e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Prioridade">
              <select className={field} value={values.priority} onChange={(e) => set("priority", e.target.value)}>
                <option value="">Sem prioridade</option>
                {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>P{p}</option>)}
              </select>
            </Field>
            <Field label="Tags (separadas por vírgula)">
              <input className={field} value={values.tags} onChange={(e) => set("tags", e.target.value)} />
            </Field>
          </div>
          <Field label="Link do monitor (opcional)">
            <input type="url" className={field} value={values.link} onChange={(e) => set("link", e.target.value)} />
          </Field>
        </Group>

        <Group title="Remediação automática">
          <label className="flex cursor-pointer items-center gap-3 text-sm text-fg">
            <input type="checkbox" className="size-4 accent-accent" checked={values.remediate} onChange={(e) => set("remediate", e.target.checked)} />
            Acionar uma ferramenta quando o alerta mudar de estado
          </label>
          {values.remediate && (
            <>
              <Field label="Nome da remediação">
                <input className={field} value={values.remediationName} onChange={(e) => set("remediationName", e.target.value)} />
              </Field>
              <Field label="Tipo">
                <select className={field} value={values.mode} onChange={(e) => set("mode", e.target.value as FormValues["mode"])}>
                  <option value="webhook">Webhook (POST com o payload padrão)</option>
                  <option value="api">API (método, headers e corpo próprios)</option>
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
                  <Field label="Headers (JSON)" hint={<>Segredos só como <code>env:NOME</code>.</>}>
                    <textarea rows={3} className={cn(field, "font-mono")} value={values.headers} onChange={(e) => set("headers", e.target.value)} placeholder='{"Authorization": "env:MEU_TOKEN"}' />
                  </Field>
                  <Field label="Corpo (modelo)" hint={<>Variáveis: {"{{alert.name}}"}, {"{{alert.state}}"}, {"{{alert.application}}"}…</>}>
                    <textarea rows={4} className={cn(field, "font-mono")} value={values.bodyTemplate} onChange={(e) => set("bodyTemplate", e.target.value)} />
                  </Field>
                </>
              )}
              <fieldset className="flex flex-wrap gap-3 border-0 p-0">
                <legend className="mb-2 text-sm text-muted">Dispara ao entrar em</legend>
                {ALERT_STATES.map((s) => (
                  <label
                    key={s}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm",
                      values.triggerStates.includes(s) ? STATE_META[s].tone : "border-line text-muted",
                    )}
                  >
                    <input type="checkbox" className="size-4 accent-accent" checked={values.triggerStates.includes(s)} onChange={() => toggleState(s)} />
                    {STATE_META[s].label}
                  </label>
                ))}
              </fieldset>
              <Field label="Timeout (ms)">
                <input type="number" min={100} max={15000} className={field} value={values.timeoutMs} onChange={(e) => set("timeoutMs", e.target.value)} />
              </Field>
            </>
          )}
        </Group>

        {errors.length > 0 && (
          <ul role="alert" className="list-disc rounded-2xl border border-alert/40 bg-alert/10 p-4 pl-8 text-sm text-alert-fg">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        <button type="submit" disabled={pending} className={cn(btnPrimary, "w-full py-3")}>
          {pending ? "Criando…" : "Criar alerta"}
        </button>
      </Card>
    </form>
  );
}
