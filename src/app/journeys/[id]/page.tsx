import Link from "next/link";
import { notFound } from "next/navigation";
import { ALERT_STATES } from "@/domain/alert-machine";
import { STATE_META } from "@/components/alert-graph/meta";
import { MutedBadge } from "@/components/muted-badge";
import { StateBadge } from "@/components/state-badge";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { btnSecondary, Card, linkClass, SectionTitle, tableCell, tableHead } from "@/components/ui/ui";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getJourneyDetail } from "@/server/queries";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

export default async function JourneyPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  const detail = await getJourneyDetail(database(), id);
  if (!detail) notFound();
  const { journey, alerts } = detail;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-6 lg:px-8">
      <Link href="/" className={`${linkClass} text-sm`}>← Mapa de jornadas</Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
            {journey.name}
            {journey.status ? <StateBadge state={journey.status} /> : <span className="text-sm font-normal text-muted">Sem alertas</span>}
          </h1>
          {journey.description && <p className="mt-1 max-w-2xl text-muted">{journey.description}</p>}
        </div>
        <div className="flex items-center gap-4">
          <AutoRefresh seconds={5} />
          <Link href={`/journeys/${id}/edit`} className={btnSecondary}>Editar jornada</Link>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {ALERT_STATES.map((s) => (
          <div key={s} className={cn("rounded-2xl border p-4", STATE_META[s].tone)}>
            <p className="flex items-center gap-2 text-xs">
              <span aria-hidden className={cn("size-2 rounded-full", STATE_META[s].dot)} />
              {STATE_META[s].label}
            </p>
            <p className="mt-2 text-3xl font-semibold tracking-tight">{journey.counts[s]}</p>
          </div>
        ))}
      </div>

      <section aria-labelledby="apps" className="flex flex-col gap-3">
        <SectionTitle id="apps">Aplicações da jornada ({journey.applications.length})</SectionTitle>
        {journey.applications.length === 0 ? (
          <p className="text-muted">Nenhuma aplicação. Use &quot;Editar jornada&quot; para adicionar.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {journey.applications.map((a) => (
              <li key={a.name}>
                <Link
                  href={`/applications/${encodeURIComponent(a.name)}`}
                  className={cn("flex flex-col gap-0.5 rounded-2xl border px-4 py-3 transition-colors hover:bg-white/5", a.status ? STATE_META[a.status].tone : "border-line text-muted")}
                >
                  <span className="font-semibold text-fg">{a.name}</span>
                  <span className="flex items-center gap-1.5 text-sm">
                    <span aria-hidden className={cn("size-2 rounded-full", a.status ? STATE_META[a.status].dot : "bg-muted")} />
                    {a.status ? STATE_META[a.status].label : "Sem alertas"}
                  </span>
                  <span className="text-xs text-muted">
                    {a.total} alertas{a.counts.alert > 0 && ` · ${a.counts.alert} em alerta`}{a.counts.warn > 0 && ` · ${a.counts.warn} aviso`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="alerts" className="flex flex-col gap-3">
        <SectionTitle id="alerts">Alertas da jornada (mais graves primeiro)</SectionTitle>
        {alerts.length === 0 ? (
          <p className="text-muted">Nenhum alerta ativo nas aplicações desta jornada.</p>
        ) : (
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <caption className="sr-only">Alertas das aplicações da jornada, dos mais graves para os menos graves</caption>
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={tableHead}>Estado</th>
                  <th scope="col" className={tableHead}>Alerta</th>
                  <th scope="col" className={tableHead}>Aplicação</th>
                  <th scope="col" className={tableHead}>Desde</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id} className="border-b border-line last:border-b-0 hover:bg-white/[0.03]">
                    <td className={tableCell}><StateBadge state={a.state} /></td>
                    <td className={tableCell}><Link className="font-medium text-fg hover:text-accent-soft" href={`/alerts/${a.id}`}>{a.name}</Link> <MutedBadge mutedUntil={a.mutedUntil} /></td>
                    <td className={tableCell}><Link className={linkClass} href={`/applications/${encodeURIComponent(a.application)}`}>{a.application}</Link></td>
                    <td className={`${tableCell} font-mono text-xs text-muted`}>{formatTime(a.stateChangedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>
    </main>
  );
}
