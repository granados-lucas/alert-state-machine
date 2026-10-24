import Link from "next/link";
import { ALERT_STATES } from "@/domain/alert-machine";
import { STATE_META } from "@/components/alert-graph/meta";
import { MutedBadge } from "@/components/muted-badge";
import { StateBadge } from "@/components/state-badge";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { btnPrimary, btnSecondary, Card, field, linkClass, PageHeader, tableCell, tableHead } from "@/components/ui/ui";
import { formatTime } from "@/lib/format";
import { listAlerts } from "@/server/queries";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const metadata = { title: "Alertas · Global Alerts" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function AlertsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const state = ALERT_STATES.find((s) => s === first(sp.state));
  const application = first(sp.application);
  const search = first(sp.q);
  const before = Number(first(sp.before)) || undefined;
  const { items, nextCursor } = await listAlerts(database(), { state, application, search, before, limit: 50 });

  const nextQuery = new URLSearchParams();
  if (state) nextQuery.set("state", state);
  if (application) nextQuery.set("application", application);
  if (search) nextQuery.set("q", search);
  if (nextCursor) nextQuery.set("before", String(nextCursor));

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-6 lg:px-8">
      <PageHeader
        title="Alertas"
        subtitle="Alertas ativos, do mais recente para o mais antigo."
        actions={
          <div className="flex items-center gap-4">
            <AutoRefresh seconds={5} />
            <Link href="/alerts/new" className={btnPrimary}>Novo alerta</Link>
          </div>
        }
      />

      <Card className="flex flex-col gap-4 p-0">
        <form method="get" className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Estado
            <select name="state" defaultValue={state ?? ""} className={`${field} min-w-36`}>
              <option value="">Todos</option>
              {ALERT_STATES.map((s) => (
                <option key={s} value={s}>{STATE_META[s].label}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Aplicação
            <input name="application" defaultValue={application ?? ""} className={field} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Nome contém
            <input name="q" defaultValue={search ?? ""} placeholder="Buscar alertas…" className={field} />
          </label>
          <button type="submit" className={btnSecondary}>Filtrar</button>
        </form>

        {items.length === 0 ? (
          <p className="p-6 text-muted">Nenhum alerta encontrado.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Alertas ativos, do mais recente para o mais antigo</caption>
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={tableHead}>Estado</th>
                  <th scope="col" className={tableHead}>Alerta</th>
                  <th scope="col" className={tableHead}>Aplicação</th>
                  <th scope="col" className={tableHead}>Prioridade</th>
                  <th scope="col" className={tableHead}>Desde</th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id} className="border-b border-line last:border-b-0 hover:bg-white/[0.03]">
                    <td className={tableCell}><StateBadge state={a.state} /></td>
                    <td className={tableCell}><Link className="font-medium text-fg hover:text-accent-soft" href={`/alerts/${a.id}`}>{a.name}</Link> <MutedBadge mutedUntil={a.mutedUntil} /></td>
                    <td className={tableCell}><Link className={linkClass} href={`/applications/${encodeURIComponent(a.application)}`}>{a.application}</Link></td>
                    <td className={`${tableCell} text-muted`}>{a.priority ? `P${a.priority}` : "—"}</td>
                    <td className={`${tableCell} font-mono text-xs text-muted`}>{formatTime(a.stateChangedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextCursor && (
          <div className="border-t border-line p-4">
            <Link className={btnSecondary} href={`/alerts?${nextQuery.toString()}`}>Carregar mais</Link>
          </div>
        )}
      </Card>
    </main>
  );
}
