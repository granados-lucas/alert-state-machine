"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { AlertState } from "@/domain/alert-machine";
import { STATE_META } from "@/components/alert-graph/meta";
import { StateBadge } from "@/components/state-badge";
import { SectionTitle } from "@/components/ui/ui";
import { cn } from "@/lib/utils";
import type { MapApplication, MapJourney } from "@/server/queries";

type Props = { journeys: MapJourney[]; unassigned: MapApplication[] };

const NEUTRAL = "border-line bg-surface-2 text-muted";
const toneOf = (status: AlertState | null) => (status ? STATE_META[status].tone : NEUTRAL);
const dotOf = (status: AlertState | null) => (status ? STATE_META[status].dot : "bg-muted");
const label = (status: AlertState | null) => (status ? STATE_META[status].label : "Sem alertas");

// Chaves de "o que mudou": j:<id> para jornadas e a:<nome> para aplicações.
function statuses(journeys: MapJourney[], unassigned: MapApplication[]) {
  const map = new Map<string, AlertState | null>();
  for (const j of journeys) {
    map.set(`j:${j.id}`, j.status);
    for (const a of j.applications) map.set(`a:${a.name}`, a.status);
  }
  for (const a of unassigned) map.set(`a:${a.name}`, a.status);
  return map;
}

export function JourneyMap({ journeys, unassigned }: Props) {
  const [onlyProblems, setOnlyProblems] = useState(false);
  // Aplicação sob o cursor/foco: o mesmo nome é destacado em todas as jornadas em que aparece.
  const [focused, setFocused] = useState<string | null>(null);

  // Itens cujo estado mudou na última atualização (destaque de 3 s). A comparação acontece durante a
  // renderização, o padrão recomendado para derivar estado de props novas.
  const [snapshot, setSnapshot] = useState({ journeys, unassigned });
  const [flashing, setFlashing] = useState<string[]>([]);
  if (snapshot.journeys !== journeys || snapshot.unassigned !== unassigned) {
    const before = statuses(snapshot.journeys, snapshot.unassigned);
    const after = statuses(journeys, unassigned);
    setFlashing([...after].filter(([key, status]) => before.has(key) && before.get(key) !== status).map(([key]) => key));
    setSnapshot({ journeys, unassigned });
  }
  useEffect(() => {
    if (flashing.length === 0) return;
    const timer = setTimeout(() => setFlashing([]), 3000);
    return () => clearTimeout(timer);
  }, [flashing]);

  const membership = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const j of journeys) for (const a of j.applications) map.set(a.name, [...(map.get(a.name) ?? []), j.name]);
    return map;
  }, [journeys]);

  const visible = onlyProblems ? journeys.filter((j) => j.status === "alert" || j.status === "warn") : journeys;

  const tile = (app: MapApplication, scope: string) => {
    const others = (membership.get(app.name) ?? []).length;
    return (
      <li key={`${scope}:${app.name}`}>
        <Link
          href={`/applications/${encodeURIComponent(app.name)}`}
          onMouseEnter={() => setFocused(app.name)}
          onMouseLeave={() => setFocused(null)}
          onFocus={() => setFocused(app.name)}
          onBlur={() => setFocused(null)}
          title={`${app.name}: ${label(app.status)} · ${app.total} alertas${app.health !== null ? ` · saúde ${app.health}%` : ""}${others > 1 ? ` · em ${others} jornadas: ${membership.get(app.name)?.join(", ")}` : ""}`}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-shadow",
            toneOf(app.status),
            focused === app.name && "ring-2 ring-accent-soft",
            flashing.includes(`a:${app.name}`) && "flash-ring",
          )}
        >
          <span aria-hidden className={cn("size-1.5 rounded-full", dotOf(app.status))} />
          <span className="font-medium text-fg">{app.name}</span>
          <span className="sr-only">{label(app.status)}</span>
          {others > 1 && <span aria-hidden className="text-[10px] text-muted">×{others}</span>}
        </Link>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>Jornadas · {visible.length} de {journeys.length}</SectionTitle>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
          <input type="checkbox" className="size-4 accent-accent" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          Só jornadas com alerta ou aviso
        </label>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-6 text-muted">
          {journeys.length === 0 ? "Nenhuma jornada definida ainda." : "Nenhuma jornada com alerta ou aviso. Tudo saudável."}
        </p>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {visible.map((j) => (
            <li key={j.id}>
              <article className={cn("flex h-full flex-col gap-3 rounded-2xl border p-4", toneOf(j.status), flashing.includes(`j:${j.id}`) && "flash-ring")}>
                <header className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold">
                      <Link href={`/journeys/${j.id}`} className="text-fg hover:underline">{j.name}</Link>
                    </h3>
                    <p className="text-xs text-muted">
                      {j.applications.length} aplicações · {j.total} alertas
                      {j.counts.alert > 0 && ` · ${j.counts.alert} em alerta${j.downgraded > 0 ? ` (${j.downgraded} de baixa prioridade)` : ""}`}
                      {j.counts.warn > 0 && ` · ${j.counts.warn} aviso`}
                      {j.health !== null && ` · saúde ${j.health}%`}
                    </p>
                  </div>
                  {j.status ? <StateBadge state={j.status} /> : <span className="text-xs text-muted">Sem alertas</span>}
                </header>
                {j.description && <p className="text-xs text-muted">{j.description}</p>}
                {j.applications.length === 0 ? (
                  <p className="text-xs text-muted">Nenhuma aplicação nesta jornada.</p>
                ) : (
                  <ul className="flex flex-wrap gap-2">{j.applications.map((a) => tile(a, `j${j.id}`))}</ul>
                )}
              </article>
            </li>
          ))}
        </ul>
      )}

      {unassigned.length > 0 && !onlyProblems && (
        <section aria-labelledby="unassigned" className="flex flex-col gap-2 rounded-2xl border border-dashed border-line p-4">
          <h3 id="unassigned" className="text-sm font-semibold">Sem jornada ({unassigned.length})</h3>
          <p className="text-xs text-muted">Aplicações com alertas que ainda não fazem parte de nenhuma jornada: não entram na saúde de nenhuma delas.</p>
          <ul className="flex flex-wrap gap-2">{unassigned.map((a) => tile(a, "u"))}</ul>
        </section>
      )}
      <p className="text-xs text-muted">×N indica uma aplicação presente em N jornadas; passar o cursor destaca a mesma aplicação nas outras jornadas.</p>
    </div>
  );
}
