import Link from "next/link";
import { describeRule, formatDuration } from "@/components/combination-form/payload";
import { CombinationStateBadge } from "@/components/combination-state-badge";
import { StateBadge } from "@/components/state-badge";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { btnPrimary, Card, PageHeader, SectionTitle } from "@/components/ui/ui";
import type { CombinationState } from "@/domain/combination";
import { cn } from "@/lib/utils";
import { listCombinations, type CombinationView } from "@/server/combination-queries";
import { currentTelemetry } from "@/server/observability";
import { EVALUATOR_STALE_MS } from "@/server/telemetry";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const metadata = { title: "Combinações · Global Alerts" };

const SECTIONS: { state: CombinationState; title: string; empty: string }[] = [
  { state: "alert", title: "Em alerta", empty: "Nenhuma combinação em alerta." },
  { state: "pending", title: "Armando", empty: "Nenhuma combinação esperando a duração." },
  { state: "ok", title: "Normais", empty: "Nenhuma combinação normal." },
];

const BORDER: Record<CombinationState, string> = { alert: "border-alert/40", pending: "border-warn/35", ok: "border-line" };

function remaining(c: CombinationView) {
  if (c.state !== "pending" || !c.satisfiedSince) return null;
  const left = c.durationSeconds - (Date.now() - c.satisfiedSince.getTime()) / 1000;
  return left > 0 ? `faltam ${formatDuration(Math.ceil(left))}` : "completa no próximo ciclo do avaliador";
}

const isLate = (last: Date | null) => !last || Date.now() - last.getTime() > EVALUATOR_STALE_MS;

function CombinationCard({ c }: { c: CombinationView }) {
  const left = remaining(c);
  return (
    <li className={cn("flex flex-col gap-3 rounded-2xl border bg-surface p-4", BORDER[c.state])}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={`/combinations/${c.id}`} className="font-semibold text-fg hover:text-accent-soft">{c.name}</Link>
        <CombinationStateBadge state={c.state} />
      </div>
      <p className="text-sm text-muted">
        {describeRule(c, c.components.length)}
        {left && <> · <strong className="text-warn">{left}</strong></>}
      </p>
      <ul className="flex flex-col gap-1.5">
        {c.components.map((k) => (
          <li key={k.id} className={cn("flex flex-wrap items-center gap-2 rounded-lg px-2 py-1 text-sm", k.alerting && "bg-alert/10")}>
            <StateBadge state={k.state} />
            <Link href={`/alerts/${k.id}`} className="min-w-0 truncate text-fg hover:text-accent-soft">{k.name}</Link>
            {k.muted && <span className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">Silenciado</span>}
            {k.archived && <span className="rounded-md border border-warn/35 bg-warn/10 px-1.5 py-0.5 text-[11px] text-warn">Arquivado</span>}
          </li>
        ))}
      </ul>
      {c.hasArchivedComponent && (
        <p className="text-xs text-warn">Há um alerta arquivado: arquivados não contam e, com a regra E, a combinação não consegue disparar.</p>
      )}
    </li>
  );
}

export default async function CombinationsPage() {
  const [combinations, telemetry] = await Promise.all([listCombinations(database()), currentTelemetry()]);
  const late = isLate(telemetry.combinationEvaluatorLastRunAt);

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-6 lg:px-8">
      <PageHeader
        title="Combinações"
        subtitle="Sinais combinados: uma combinação observa 1 ou mais alertas por uma regra (E, OU, pelo menos N) e dispara a própria automação. Não altera o mapa de jornadas nem a saúde."
        actions={
          <div className="flex items-center gap-4">
            <AutoRefresh seconds={5} />
            <Link href="/combinations/new" className={btnPrimary}>Nova combinação</Link>
          </div>
        }
      />

      {combinations.length > 0 && late && (
        <p role="alert" className="rounded-2xl border border-alert/40 bg-alert/10 p-4 text-sm text-alert-fg">
          O avaliador de combinações não rodou nos últimos {EVALUATOR_STALE_MS / 60_000} minutos: as combinações com duração não completam sozinhas. Confira o serviço <code>combination-evaluator</code> e a página <Link className="underline" href="/status">Status</Link>.
        </p>
      )}

      {combinations.length === 0 ? (
        <Card><p className="text-muted">Nenhuma combinação ainda. <Link className="text-accent-soft underline-offset-4 hover:underline" href="/combinations/new">Criar a primeira</Link>.</p></Card>
      ) : (
        SECTIONS.map(({ state, title, empty }) => {
          const items = combinations.filter((c) => c.state === state);
          return (
            <section key={state} aria-labelledby={`sec-${state}`} className="flex flex-col gap-3">
              <SectionTitle id={`sec-${state}`}>{title} ({items.length})</SectionTitle>
              {items.length === 0 ? <p className="text-sm text-muted">{empty}</p> : <ul className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">{items.map((c) => <CombinationCard key={c.id} c={c} />)}</ul>}
            </section>
          );
        })
      )}
    </main>
  );
}
