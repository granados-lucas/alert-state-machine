"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { btnPrimary, Card, field } from "@/components/ui/ui";
import { cn } from "@/lib/utils";
import { buildCreateJourneyBody, buildJourneyPatch, collectApplications, type JourneyFormValues } from "./payload";

type Props = {
  allApplications: string[];
  /** Presente na edição. */
  journey?: { id: number; name: string; description: string | null; applications: string[] };
};

async function call(path: string, method: string, body: unknown) {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

const errorsOf = (data: { error?: string; issues?: { path: string; message: string }[] }, status: number) =>
  data.issues ? data.issues.map((i) => `${i.path || "corpo"}: ${i.message}`) : [data.error ?? `Erro ${status}`];

export function JourneyForm({ allApplications, journey }: Props) {
  const router = useRouter();
  const [values, setValues] = useState<JourneyFormValues>({
    name: journey?.name ?? "",
    description: journey?.description ?? "",
    selected: journey?.applications.filter((a) => allApplications.includes(a)) ?? [],
    // Aplicações da jornada que o catálogo ainda não lista ficam no campo de texto.
    extra: journey?.applications.filter((a) => !allApplications.includes(a)).join(", ") ?? "",
  });
  const [filter, setFilter] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, setPending] = useState(false);

  const shown = useMemo(() => allApplications.filter((a) => a.toLowerCase().includes(filter.toLowerCase())), [allApplications, filter]);
  const toggle = (name: string) =>
    setValues((v) => ({ ...v, selected: v.selected.includes(name) ? v.selected.filter((s) => s !== name) : [...v.selected, name] }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setErrors([]);
    try {
      if (!journey) {
        const r = await call("/api/journeys", "POST", buildCreateJourneyBody(values));
        if (!r.ok) return setErrors(errorsOf(r.data, r.status));
        return router.push(`/journeys/${r.data.id}`);
      }
      const patch = buildJourneyPatch(values, journey);
      if (patch) {
        const r = await call(`/api/journeys/${journey.id}`, "PATCH", patch);
        if (!r.ok) return setErrors(errorsOf(r.data, r.status));
      }
      const r = await call(`/api/journeys/${journey.id}/applications`, "PUT", { applications: collectApplications(values) });
      if (!r.ok) return setErrors(errorsOf(r.data, r.status));
      router.push(`/journeys/${journey.id}`);
    } catch {
      setErrors(["Não foi possível falar com o servidor."]);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <Card className="flex flex-col gap-6 p-6">
        <label className="flex flex-col gap-1.5 text-sm text-muted">
          Nome da jornada
          <input required className={field} value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} placeholder="Ex.: Compra" />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-muted">
          Descrição (opcional)
          <textarea rows={2} className={field} value={values.description} onChange={(e) => setValues({ ...values, description: e.target.value })} />
        </label>

        <fieldset className="flex flex-col gap-3 border-0 p-0">
          <legend className="mb-1 text-base font-semibold text-fg">Aplicações da jornada ({collectApplications(values).length})</legend>
          <input
            className={field}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filtrar aplicações…"
            aria-label="Filtrar aplicações"
          />
          <ul className="grid max-h-72 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {shown.map((name) => (
              <li key={name}>
                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm",
                    values.selected.includes(name) ? "border-accent/60 bg-accent/10 text-fg" : "border-line text-muted",
                  )}
                >
                  <input type="checkbox" className="size-4 accent-accent" checked={values.selected.includes(name)} onChange={() => toggle(name)} />
                  {name}
                </label>
              </li>
            ))}
            {shown.length === 0 && <li className="text-sm text-muted">Nenhuma aplicação encontrada.</li>}
          </ul>
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            Outras aplicações (ainda sem alertas), separadas por vírgula
            <input className={field} value={values.extra} onChange={(e) => setValues({ ...values, extra: e.target.value })} />
            <span className="text-xs">Use o mesmo valor da tag service: do monitor. Uma aplicação pode estar em várias jornadas.</span>
          </label>
        </fieldset>

        {errors.length > 0 && (
          <ul role="alert" className="list-disc rounded-2xl border border-alert/40 bg-alert/10 p-4 pl-8 text-sm text-alert-fg">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        <button type="submit" disabled={pending} className={cn(btnPrimary, "w-full py-3")}>
          {pending ? "Salvando…" : journey ? "Salvar jornada" : "Criar jornada"}
        </button>
      </Card>
    </form>
  );
}
