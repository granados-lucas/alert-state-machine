import Link from "next/link";
import { notFound } from "next/navigation";
import { ALERT_STATES } from "@/domain/alert-machine";
import { STATE_META } from "@/components/alert-graph/meta";
import { StateBadge } from "@/components/state-badge";
import { Card, linkClass, SectionTitle } from "@/components/ui/ui";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getApplicationDetail } from "@/server/queries";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

export default async function ApplicationPage({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  const detail = await getApplicationDetail(database(), name);
  if (!detail) notFound();
  const { application, alerts, journeys } = detail;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-6 lg:px-8">
      <Link href="/" className={`${linkClass} text-sm`}>← Mapa</Link>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{application.name}</h1>
        {application.status && <StateBadge state={application.status} />}
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {ALERT_STATES.map((s) => (
          <div key={s} className={cn("rounded-2xl border p-4", STATE_META[s].tone)}>
            <p className="flex items-center gap-2 text-xs">
              <span aria-hidden className={cn("size-2 rounded-full", STATE_META[s].dot)} />
              {STATE_META[s].label}
            </p>
            <p className="mt-2 text-3xl font-semibold tracking-tight">{application.counts[s]}</p>
          </div>
        ))}
      </div>

      <Card>
        <dl className="grid gap-2 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
          <dt className="text-muted">Jornadas</dt>
          <dd>
            {journeys.length === 0
              ? "Nenhuma (esta aplicação não entra na saúde de nenhuma jornada)"
              : journeys.map((j, i) => (
                  <span key={j.id}>{i > 0 && ", "}<Link className={linkClass} href={`/journeys/${j.id}`}>{j.name}</Link></span>
                ))}
          </dd>
        </dl>
      </Card>

      <section className="flex flex-col gap-3">
        <SectionTitle>Alertas</SectionTitle>
        {alerts.length === 0 ? (
          <p className="text-muted">Nenhum alerta ativo.</p>
        ) : (
          <Card className="p-0">
            <ul>
              {alerts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3 last:border-b-0">
                  <StateBadge state={a.state} />
                  <Link className="font-medium text-fg hover:text-accent-soft" href={`/alerts/${a.id}`}>{a.name}</Link>
                  <span className="ml-auto font-mono text-xs text-muted">desde {formatTime(a.stateChangedAt)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </main>
  );
}
