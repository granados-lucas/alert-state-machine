import Link from "next/link";
import { JourneyMap } from "@/components/journey-map/journey-map";
import { StateBadge } from "@/components/state-badge";
import { ActivityIcon, AlertIcon, CheckIcon, FlowIcon, WarnIcon } from "@/components/ui/icons";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { btnPrimary, Card, KpiCard, PageHeader, SectionTitle, linkClass } from "@/components/ui/ui";
import { formatTime } from "@/lib/format";
import { getJourneyMap, getRecentChanges } from "@/server/queries";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

export default async function Home() {
  const db = database();
  const [{ journeys, unassigned, totalApplications }, recent] = await Promise.all([getJourneyMap(db), getRecentChanges(db, 8)]);
  const by = { alert: 0, warn: 0, no_data: 0, ok: 0 };
  for (const j of journeys) if (j.status) by[j.status] += 1;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-6 lg:px-8">
      <PageHeader
        title="Mapa de jornadas"
        subtitle="Saúde de cada jornada: se um alerta de qualquer aplicação dela estiver em Alerta, a aplicação e a jornada ficam vermelhas. Uma aplicação pode fazer parte de mais de uma jornada."
        actions={
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-4">
              <AutoRefresh seconds={5} />
              <Link href="/journeys/new" className={btnPrimary}>Nova jornada</Link>
            </div>
            <span className="font-mono text-xs text-muted">dados de {formatTime(new Date()).slice(11)}</span>
          </div>
        }
      />

      {journeys.length === 0 && totalApplications === 0 ? (
        <Card className="border-dashed text-muted">
          Nada por aqui ainda. Os alertas aparecem quando uma fonte (Datadog, CloudWatch…) envia o primeiro webhook ou quando você{" "}
          <Link className={linkClass} href="/alerts/new">cria um alerta</Link>; depois, agrupe as aplicações em{" "}
          <Link className={linkClass} href="/journeys/new">jornadas</Link>.
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard icon={<FlowIcon />} label="Jornadas" value={journeys.length} hint={`${totalApplications} aplicações · ${unassigned.length} sem jornada`} tone="accent" />
            <KpiCard icon={<AlertIcon />} label="Em alerta" value={by.alert} hint="jornadas com ao menos 1 alerta" tone="alert" />
            <KpiCard icon={<WarnIcon />} label="Em aviso" value={by.warn} hint="sem nenhum alerta em Alerta" tone="warn" />
            <KpiCard icon={<CheckIcon />} label="Saudáveis" value={by.ok} hint={`${by.no_data} sem dados`} tone="ok" />
          </div>

          <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
            <JourneyMap journeys={journeys} unassigned={unassigned} />
            <Card className="flex h-fit flex-col gap-4">
              <div className="flex items-center justify-between">
                <SectionTitle>Mudanças recentes</SectionTitle>
                <span className="text-accent-soft"><ActivityIcon /></span>
              </div>
              {recent.length === 0 ? (
                <p className="text-sm text-muted">Nenhuma mudança de estado ainda.</p>
              ) : (
                <ol className="flex flex-col">
                  {recent.map((c) => (
                    <li key={c.id} className="border-t border-line py-3 first:border-t-0 first:pt-0">
                      <div className="flex items-center justify-between gap-2 text-xs text-muted">
                        <span className="truncate">{c.application}</span>
                        <time dateTime={c.at.toISOString()}>{formatTime(c.at).slice(11, 19)} UTC</time>
                      </div>
                      <Link href={`/alerts/${c.alertId}`} className="mt-0.5 block truncate font-medium text-fg hover:text-accent-soft">
                        {c.alertName}
                      </Link>
                      <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
                        {c.fromState && <StateBadge state={c.fromState} />}
                        <span aria-label="para">→</span>
                        {c.toState && <StateBadge state={c.toState} />}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              <Link href="/alerts" className={`${linkClass} text-sm`}>Ver todos os alertas →</Link>
            </Card>
          </div>
        </>
      )}
    </main>
  );
}
