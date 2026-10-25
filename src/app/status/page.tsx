import Link from "next/link";
import { StateBadge } from "@/components/state-badge";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { Card, PageHeader, SectionTitle, linkClass, tableCell, tableHead } from "@/components/ui/ui";
import { ALERT_STATES } from "@/domain/alert-machine";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { listProviderInfo } from "@/providers/catalog";
import { appVersion, currentTelemetry, uptimeMinutes } from "@/server/observability";

export const dynamic = "force-dynamic";
export const metadata = { title: "Status · Global Alerts" };

const RUN_STATUS: Record<string, string> = { running: "Em andamento", succeeded: "Concluída", partial: "Parcial", failed: "Falhou" };

function ago(value: Date | null) {
  if (!value) return null;
  const seconds = Math.max(0, Math.round((Date.now() - value.getTime()) / 1000));
  if (seconds < 90) return `há ${seconds} s`;
  if (seconds < 5400) return `há ${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `há ${Math.round(seconds / 3600)} h`;
  return `há ${Math.round(seconds / 86400)} dias`;
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "alert" }) {
  return (
    <Card className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <span className={cn("text-lg font-semibold", tone === "ok" && "text-ok", tone === "warn" && "text-warn", tone === "alert" && "text-alert-fg")}>{value}</span>
    </Card>
  );
}

export default async function StatusPage() {
  const t = await currentTelemetry();
  const labels = new Map(listProviderInfo().map((p) => [p.id, p.label]));
  const remediation = t.recentRemediations;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-6 lg:px-8">
      <PageHeader
        title="Status da aplicação"
        subtitle="Saúde do próprio Global Alerts: banco, fontes de alertas, silêncios pendentes, reconciliação e remediações. As mesmas medidas saem em /api/metrics para o Prometheus."
        actions={<AutoRefresh seconds={15} />}
      />

      <section aria-label="Resumo" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Banco de dados" value={t.db.up ? `Conectado · ${t.db.latencyMs} ms` : "Indisponível"} tone={t.db.up ? "ok" : "alert"} />
        <Fact label="Silêncios pendentes" value={t.pendingMutes.count === 0 ? "Nenhum" : `${t.pendingMutes.count} (mais antigo ${ago(t.pendingMutes.oldestAt)})`} tone={t.pendingMutes.count === 0 ? "ok" : "warn"} />
        <Fact
          label={`Remediações (últimas ${remediation.total})`}
          value={remediation.total === 0 ? "Nenhuma ainda" : `${remediation.failed} falha(s), ${remediation.skipped} pulada(s)`}
          tone={remediation.total === 0 ? undefined : remediation.failed > 0 ? "warn" : "ok"}
        />
        <Fact label="Versão · no ar há" value={`${appVersion()} · ${uptimeMinutes()} min`} />
      </section>

      <section aria-labelledby="sources" className="flex flex-col gap-3">
        <SectionTitle id="sources">Fontes de alertas</SectionTitle>
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <caption className="sr-only">Situação de cada fonte de alertas</caption>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className={tableHead}>Fonte</th>
                <th scope="col" className={tableHead}>Webhook</th>
                <th scope="col" className={tableHead}>API (silenciar / reconciliar)</th>
                <th scope="col" className={tableHead}>Último evento aplicado</th>
              </tr>
            </thead>
            <tbody>
              {t.providers.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-b-0">
                  <td className={`${tableCell} font-medium`}>{labels.get(p.id as never) ?? p.id}</td>
                  <td className={tableCell}>{p.webhook ? "Habilitado" : <span className="text-muted">Desligado (sem segredo válido)</span>}</td>
                  <td className={tableCell}>{p.control || p.source ? "Configurada" : <span className="text-muted">Não configurada ou não suportada</span>}</td>
                  <td className={tableCell}>
                    {p.lastEventAt ? <>{formatTime(p.lastEventAt)} <span className="text-muted">({ago(p.lastEventAt)})</span></> : <span className="text-muted">nenhum</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <p className="text-xs text-muted">
          Uma fonte habilitada sem eventos há muito tempo pode indicar webhook quebrado, mas só você sabe o ritmo normal dela: para alertar sobre isso use{" "}
          <code>time() - global_alerts_last_event_timestamp_seconds</code> no Prometheus.
        </p>
      </section>

      <section aria-labelledby="alerts-by-state" className="flex flex-col gap-3">
        <SectionTitle id="alerts-by-state">Alertas ativos por estado</SectionTitle>
        <div className="flex flex-wrap gap-3">
          {ALERT_STATES.map((state) => (
            <Card key={state} className="flex items-center gap-3">
              <StateBadge state={state} />
              <span className="text-lg font-semibold">{t.alertsByState[state] ?? 0}</span>
            </Card>
          ))}
        </div>
      </section>

      <section aria-labelledby="reconciliation" className="flex flex-col gap-3">
        <SectionTitle id="reconciliation">Última reconciliação</SectionTitle>
        <Card>
          {t.lastReconciliation ? (
            <p className="text-sm">
              {RUN_STATUS[t.lastReconciliation.status] ?? t.lastReconciliation.status}
              {t.lastReconciliation.dryRun ? " (simulação)" : ""} · {labels.get(t.lastReconciliation.provider as never) ?? t.lastReconciliation.provider} · iniciada em {formatTime(t.lastReconciliation.startedAt)} ({ago(t.lastReconciliation.startedAt)}) ·{" "}
              <Link className={linkClass} href="/reconciliation">detalhes</Link>
            </p>
          ) : (
            <p className="text-sm text-muted">Nunca executada. <Link className={linkClass} href="/reconciliation">Abrir a reconciliação</Link>.</p>
          )}
        </Card>
      </section>
    </main>
  );
}
