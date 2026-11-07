"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { StateBadge } from "@/components/state-badge";
import { btnPrimary, btnSecondary, Card, field } from "@/components/ui/ui";
import type { AlertState } from "@/domain/alert-machine";
import type { CombinationRule } from "@/domain/combination";
import { cn } from "@/lib/utils";
import { AutomationFields, Field } from "./automation-fields";
import { buildCombinationPayload, emptyCombination, type CombinationValues } from "./payload";

const MAX_ALERTS = 20;

type Picked = { id: number; name: string };
type Found = { id: number; name: string; application: string; state: AlertState };
type Props = {
  /** Presente na edição. */
  combination?: { id: number; name: string; description: string | null; rule: CombinationRule; minCount: number | null; durationSeconds: number; components: Picked[] };
};

const RULES: { value: CombinationRule; label: string; hint: string }[] = [
  { value: "and", label: "E", hint: "todos os alertas em alerta" },
  { value: "or", label: "OU", hint: "pelo menos um em alerta" },
  { value: "at_least", label: "Pelo menos N", hint: "N ou mais em alerta" },
];

const errorsOf = (data: { error?: string; issues?: { path: string; message: string }[] }, status: number) =>
  data.issues ? data.issues.map((i) => `${i.path || "corpo"}: ${i.message}`) : [data.error ?? `Erro ${status}`];

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-4 border-0 p-0">
      <legend className="mb-3 text-base font-semibold text-fg">{title}</legend>
      {children}
    </fieldset>
  );
}

export function CombinationForm({ combination }: Props) {
  const router = useRouter();
  const [values, setValues] = useState<CombinationValues>(
    combination
      ? { ...emptyCombination, name: combination.name, description: combination.description ?? "", rule: combination.rule, minCount: String(combination.minCount ?? 2), minutes: String(combination.durationSeconds / 60) }
      : emptyCombination,
  );
  const [picked, setPicked] = useState<Picked[]>(combination?.components ?? []);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const set = <K extends keyof CombinationValues>(key: K, value: CombinationValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  async function search() {
    setErrors([]);
    try {
      const response = await fetch(`/api/alerts?search=${encodeURIComponent(query.trim())}&limit=20`);
      const data = await response.json();
      setFound(response.ok ? data.items : []);
      if (!response.ok) setErrors(errorsOf(data, response.status));
    } catch {
      setErrors(["Não foi possível buscar os alertas."]);
    }
  }
  const add = (alert: Found) => setPicked((list) => (list.some((p) => p.id === alert.id) || list.length >= MAX_ALERTS ? list : [...list, { id: alert.id, name: alert.name }]));
  const remove = (id: number) => setPicked((list) => list.filter((p) => p.id !== id));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const payload = buildCombinationPayload({ ...values, alertIds: picked.map((p) => p.id) }, combination ? "edit" : "create");
    if (!payload.ok) return setErrors([payload.error]);
    setPending(true);
    setErrors([]);
    try {
      const response = await fetch(combination ? `/api/combinations/${combination.id}` : "/api/combinations", {
        method: combination ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload.body),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        router.push(`/combinations/${data.id}`);
        router.refresh();
        return;
      }
      setErrors(errorsOf(data, response.status));
    } catch {
      setErrors(["Não foi possível falar com o servidor."]);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <Card className="flex flex-col gap-8 p-6">
        <Group title="Informações básicas">
          <Field label="Nome">
            <input required className={field} value={values.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Descrição (opcional)" hint="Por exemplo: queda de conversão do ponto A ao B junto com latência alta no checkout.">
            <input className={field} value={values.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
        </Group>

        <Group title="Alertas observados">
          <div className="flex gap-2">
            <input
              aria-label="Buscar alertas pelo nome"
              className={field}
              placeholder="Buscar alertas pelo nome…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void search();
                }
              }}
            />
            <button type="button" className={btnSecondary} onClick={() => void search()}>Buscar</button>
          </div>
          {found && (
            <ul aria-label="Resultado da busca" className="flex max-h-64 flex-col overflow-y-auto rounded-xl border border-line">
              {found.length === 0 && <li className="p-3 text-sm text-muted">Nenhum alerta encontrado.</li>}
              {found.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 text-sm last:border-b-0">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <StateBadge state={a.state} />
                    <span className="truncate font-medium text-fg">{a.name}</span>
                    <span className="text-xs text-muted">{a.application}</span>
                  </span>
                  <button type="button" className={btnSecondary} disabled={picked.some((p) => p.id === a.id) || picked.length >= MAX_ALERTS} onClick={() => add(a)}>
                    {picked.some((p) => p.id === a.id) ? "Adicionado" : "Adicionar"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <p className="mb-2 text-sm text-muted">Escolhidos ({picked.length} de {MAX_ALERTS})</p>
            {picked.length === 0 ? (
              <p className="text-sm text-muted">Nenhum ainda. Busque e adicione pelo menos um alerta.</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {picked.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 py-1 pl-3 pr-1 text-sm">
                    {p.name}
                    <button type="button" className="rounded-lg px-2 py-0.5 text-muted hover:bg-white/5 hover:text-fg" aria-label={`Remover ${p.name}`} onClick={() => remove(p.id)}>×</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Group>

        <Group title="Regra">
          <div role="radiogroup" aria-label="Regra" className="grid gap-3 sm:grid-cols-3">
            {RULES.map((r) => (
              <label key={r.value} className={cn("flex cursor-pointer flex-col gap-1 rounded-xl border px-3 py-2 text-sm", values.rule === r.value ? "border-accent bg-accent/10 text-fg" : "border-line text-muted")}>
                <span className="flex items-center gap-2">
                  <input type="radio" name="rule" className="size-4 accent-accent" checked={values.rule === r.value} onChange={() => set("rule", r.value)} />
                  <strong>{r.label}</strong>
                </span>
                <span className="text-xs">{r.hint}</span>
              </label>
            ))}
          </div>
          {values.rule === "at_least" && (
            <Field label="Quantos alertas, no mínimo" hint={`Entre 1 e ${Math.max(picked.length, 1)} (o número de alertas escolhidos).`}>
              <input type="number" min={1} max={Math.max(picked.length, 1)} className={field} value={values.minCount} onChange={(e) => set("minCount", e.target.value)} />
            </Field>
          )}
          <Field label="Por quantos minutos seguidos" hint="0 = dispara assim que a regra valer. Se a regra deixar de valer antes do tempo, a contagem recomeça.">
            <input type="number" min={0} max={1440} step="any" className={field} value={values.minutes} onChange={(e) => set("minutes", e.target.value)} />
          </Field>
          <p className="text-xs text-muted">Só o estado Alerta conta; aviso, sem dados, normal, silenciados e arquivados não contam.</p>
        </Group>

        {!combination && (
          <Group title="Automação">
            <label className="flex cursor-pointer items-center gap-3 text-sm text-fg">
              <input type="checkbox" className="size-4 accent-accent" checked={values.addAutomation} onChange={(e) => set("addAutomation", e.target.checked)} />
              Acionar uma ferramenta quando a combinação mudar de estado
            </label>
            {values.addAutomation && <AutomationFields values={values.automation} onChange={(automation) => set("automation", automation)} />}
          </Group>
        )}

        {errors.length > 0 && (
          <ul role="alert" className="list-disc rounded-2xl border border-alert/40 bg-alert/10 p-4 pl-8 text-sm text-alert-fg">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        <button type="submit" disabled={pending} className={cn(btnPrimary, "w-full py-3")}>
          {pending ? "Salvando…" : combination ? "Salvar alterações" : "Criar combinação"}
        </button>
      </Card>
    </form>
  );
}
