import Link from "next/link";
import { notFound } from "next/navigation";
import { MuteControl } from "@/components/mute-control/mute-control";
import { StateBadge } from "@/components/state-badge";
import { MutedBadge } from "@/components/muted-badge";
import { STATE_META } from "@/components/alert-graph/meta";
import { Card, linkClass, SectionTitle, tableCell, tableHead } from "@/components/ui/ui";
import { effectiveState, weightOf } from "@/domain/application-status";
import { isMuted } from "@/domain/mute";
import { getDatadogApiConfig } from "@/lib/env";
import { resolveOverallState } from "@/providers/datadog/states";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getAlertDetail } from "@/server/queries";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  alert_created: "Alerta criado",
  alert_updated: "Alerta alterado",
  alert_archived: "Alerta arquivado/restaurado",
  state_changed: "Mudança de estado",
  remediation_created: "Remediação criada",
  remediation_updated: "Remediação alterada",
  remediation_run: "Remediação executada",
  dependencies_updated: "Dependências alteradas (legado)",
  journey_created: "Jornada criada",
  journey_updated: "Jornada alterada",
  journey_applications_updated: "Aplicações da jornada alteradas",
  journey_deleted: "Jornada removida",
  monitor_muted: "Monitor silenciado no provedor",
  monitor_unmuted: "Silêncio removido no provedor",
  monitor_mute_failed: "Falha ao silenciar/reativar no provedor",
};

const RUN_TONE: Record<string, string> = {
  success: "border-ok/30 bg-ok/10 text-ok",
  failed: "border-alert/40 bg-alert/10 text-alert-fg",
  skipped: "border-warn/35 bg-warn/10 text-warn",
};
const RUN_LABEL: Record<string, string> = { success: "Sucesso", failed: "Falhou", skipped: "Pulada" };

export default async function AlertPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  const detail = await getAlertDetail(database(), id);
  if (!detail) notFound();
  const { alert, remediations, runs, audit, journeys, pendingMute } = detail;
  const muted = isMuted(alert.mutedUntil);
  const reported = alert.provider === "datadog" && alert.providerState ? resolveOverallState(alert.providerState) : null;
  const canMute = alert.provider === "datadog" && getDatadogApiConfig() !== undefined;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-6 lg:px-8">
      <Link href="/alerts" className={`${linkClass} text-sm`}>← Alertas</Link>
      <header className="flex flex-col gap-3">
        <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
          {alert.name}
          <StateBadge state={alert.state} />
          <MutedBadge mutedUntil={alert.mutedUntil} />
          {alert.archivedAt && <span className="rounded-md border border-line px-2 py-0.5 text-xs text-muted">Arquivado</span>}
        </h1>
        <Card>
          <dl className="grid gap-2 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
            <dt className="text-muted">Aplicação</dt>
            <dd><Link className={linkClass} href={`/applications/${encodeURIComponent(alert.application)}`}>{alert.application}</Link></dd>
            <dt className="text-muted">Jornadas</dt>
            <dd>
              {journeys.length === 0
                ? "—"
                : journeys.map((j, i) => (
                    <span key={j.id}>{i > 0 && ", "}<Link className={linkClass} href={`/journeys/${j.id}`}>{j.name}</Link></span>
                  ))}
            </dd>
            <dt className="text-muted">Origem</dt>
            <dd>{alert.provider} · monitor {alert.externalId}{alert.link && <> · <a className={linkClass} href={alert.link} rel="noreferrer noopener">abrir no provedor</a></>}</dd>
            {reported && (
              <>
                <dt className="text-muted">Estado no Datadog</dt>
                <dd>
                  <span className="font-medium">{reported.raw}</span>
                  {reported.state ? <> equivale a <StateBadge state={reported.state} /></> : <> não altera o estado</>}
                  {reported.state && reported.state !== alert.state && <span className="ml-2 text-warn">diferente do estado aqui ({STATE_META[alert.state].label}): rode a reconciliação</span>}
                  <span className="ml-2 font-mono text-xs text-muted">lido em {formatTime(alert.providerStateAt)}</span>
                  <span className="block text-xs text-muted">{reported.reason}</span>
                </dd>
              </>
            )}
            <dt className="text-muted">Prioridade</dt>
            <dd>{alert.priority ? `P${alert.priority}` : "sem prioridade (conta como P3)"} · peso {weightOf(alert.priority)} na saúde{alert.state === "alert" && effectiveState(alert.state, alert.priority) !== alert.state ? " · em Alerta, mas de baixa prioridade: não deixa a aplicação vermelha" : ""}</dd>
            <dt className="text-muted">Estado desde</dt>
            <dd className="font-mono text-xs leading-6">{formatTime(alert.stateChangedAt)} (último evento: {formatTime(alert.lastEventAt)})</dd>
            <dt className="text-muted">Tags</dt>
            <dd>{alert.tags.length ? alert.tags.join(", ") : "—"}</dd>
          </dl>
        </Card>
      </header>

      <MuteControl
        alertId={alert.id}
        provider={alert.provider}
        enabled={canMute}
        mute={
          muted && alert.mutedUntil
            ? { until: alert.mutedUntil.toISOString(), scope: alert.mutedScope, reason: alert.muteReason, by: alert.mutedBy, at: alert.mutedAt?.toISOString() ?? null }
            : null
        }
        expiredAt={!muted && alert.mutedUntil ? alert.mutedUntil.toISOString() : null}
        pending={pendingMute ? { action: pendingMute.action, since: pendingMute.createdAt.toISOString() } : null}
      />

      <section aria-labelledby="rem" className="flex flex-col gap-3">
        <SectionTitle id="rem">Remediações</SectionTitle>
        {remediations.length === 0 ? (
          <p className="text-sm text-muted">Nenhuma remediação configurada.</p>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {remediations.map((r) => (
              <li key={r.id} className="rounded-2xl border border-line bg-surface p-4 text-sm">
                <p className="flex items-center justify-between gap-2">
                  <strong className="text-fg">{r.name}</strong>
                  <span className={cn("rounded-md border px-2 py-0.5 text-xs", r.enabled ? "border-ok/30 bg-ok/10 text-ok" : "border-line text-muted")}>
                    {r.enabled ? "Ativa" : "Desativada"}
                  </span>
                </p>
                <p className="mt-1 text-muted">{r.mode === "webhook" ? "Webhook" : `API ${r.method}`} para <code className="break-all font-mono text-xs text-fg">{r.url}</code></p>
                <p className="mt-2 text-xs text-muted">
                  Dispara ao entrar em: {r.triggerStates.map((s) => STATE_META[s].label).join(", ")} · timeout {r.timeoutMs} ms
                </p>
              </li>
            ))}
          </ul>
        )}
        {runs.length > 0 && (
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <caption className="sr-only">Execuções de remediação</caption>
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={tableHead}>Quando</th>
                  <th scope="col" className={tableHead}>Estado</th>
                  <th scope="col" className={tableHead}>Resultado</th>
                  <th scope="col" className={tableHead}>Detalhe</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-b-0">
                    <td className={`${tableCell} font-mono text-xs text-muted`}>{formatTime(r.at)}</td>
                    <td className={tableCell}>{STATE_META[r.triggerState].label}</td>
                    <td className={tableCell}>
                      <span className={cn("rounded-md border px-2 py-0.5 text-xs", RUN_TONE[r.status])}>{RUN_LABEL[r.status] ?? r.status}</span>
                    </td>
                    <td className={`${tableCell} text-muted`}>{r.httpStatus ? `HTTP ${r.httpStatus}` : r.error ?? ""}{r.durationMs !== null && ` · ${r.durationMs} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      <section aria-labelledby="audit" className="flex flex-col gap-3">
        <SectionTitle id="audit">Histórico e auditoria</SectionTitle>
        <Card className="p-0">
          <ol>
            {audit.map((a) => (
              <li key={a.id} className="border-b border-line px-5 py-3 text-sm last:border-b-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-xs text-muted">{formatTime(a.at)}</span>
                  <strong className="text-fg">{KIND_LABEL[a.kind] ?? a.kind}</strong>
                  <span className="text-muted">{a.actor}</span>
                  {a.fromState && a.toState && (
                    <span className="flex items-center gap-2"><StateBadge state={a.fromState} /><span aria-label="para">→</span><StateBadge state={a.toState} /></span>
                  )}
                </div>
                {Object.keys(a.details).length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-accent-soft">detalhes</summary>
                    <pre className="mt-1 overflow-x-auto rounded-xl bg-bg p-3 font-mono text-xs text-muted">{JSON.stringify(a.details, null, 2)}</pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
        </Card>
      </section>
    </main>
  );
}
