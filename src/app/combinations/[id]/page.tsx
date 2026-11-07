import Link from "next/link";
import { notFound } from "next/navigation";
import { ArchiveButton } from "@/components/combination-form/archive-button";
import { AutomationManager } from "@/components/combination-form/automation-manager";
import { describeRule } from "@/components/combination-form/payload";
import { CombinationStateBadge, COMBINATION_STATE_META } from "@/components/combination-state-badge";
import { StateBadge } from "@/components/state-badge";
import { Card, linkClass, PageHeader, SectionTitle, tableCell, tableHead } from "@/components/ui/ui";
import type { CombinationState } from "@/domain/combination";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getCombination } from "@/server/combination-queries";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  combination_created: "Combinação criada",
  combination_updated: "Combinação alterada",
  combination_archived: "Combinação arquivada/restaurada",
  combination_state_changed: "Mudança de estado",
  combination_automation_created: "Automação criada",
  combination_automation_updated: "Automação alterada",
  combination_automation_run: "Automação executada",
};

const RUN_TONE: Record<string, string> = {
  success: "border-ok/30 bg-ok/10 text-ok",
  failed: "border-alert/40 bg-alert/10 text-alert-fg",
  skipped: "border-warn/35 bg-warn/10 text-warn",
};
const RUN_LABEL: Record<string, string> = { success: "Sucesso", failed: "Falhou", skipped: "Pulada" };

export default async function CombinationPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  const c = await getCombination(database(), id);
  if (!c) notFound();
  const archived = c.archivedAt !== null;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-6 lg:px-8">
      <Link href="/combinations" className={`${linkClass} text-sm`}>← Combinações</Link>
      <PageHeader
        title={c.name}
        subtitle={c.description ?? undefined}
        actions={
          <div className="flex items-start gap-3">
            <Link href={`/combinations/${id}/edit`} className="inline-flex items-center rounded-xl border border-line bg-surface-2 px-4 py-2 text-sm font-medium text-accent-soft hover:bg-white/5">Editar</Link>
            <ArchiveButton combinationId={id} archived={archived} />
          </div>
        }
      />

      <section aria-label="Situação" className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <CombinationStateBadge state={c.state} />
        {archived && <span className="rounded-md border border-warn/35 bg-warn/10 px-2 py-0.5 text-xs text-warn">Arquivada em {formatTime(c.archivedAt)}</span>}
        <span className="text-muted">Regra: <strong className="text-fg">{describeRule(c, c.components.length)}</strong></span>
        <span className="text-muted">Estado desde <span className="font-mono text-xs">{formatTime(c.stateChangedAt)}</span></span>
        {c.satisfiedSince && <span className="text-muted">Regra valendo desde <span className="font-mono text-xs">{formatTime(c.satisfiedSince)}</span></span>}
      </section>

      <section aria-labelledby="components" className="flex flex-col gap-3">
        <SectionTitle id="components">Alertas observados ({c.alertingCount} alertando de {c.components.length})</SectionTitle>
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <caption className="sr-only">Alertas observados pela combinação</caption>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className={tableHead}>Estado</th>
                <th scope="col" className={tableHead}>Alerta</th>
                <th scope="col" className={tableHead}>Aplicação</th>
                <th scope="col" className={tableHead}>Conta?</th>
                <th scope="col" className={tableHead}>Desde</th>
              </tr>
            </thead>
            <tbody>
              {c.components.map((k) => (
                <tr key={k.id} className="border-b border-line last:border-b-0">
                  <td className={tableCell}><StateBadge state={k.state} /></td>
                  <td className={tableCell}><Link className="font-medium text-fg hover:text-accent-soft" href={`/alerts/${k.id}`}>{k.name}</Link></td>
                  <td className={`${tableCell} text-muted`}>{k.application}</td>
                  <td className={tableCell}>
                    {k.alerting ? <span className="text-alert-fg">Sim, alertando</span> : <span className="text-muted">{k.archived ? "Não (arquivado)" : k.muted ? "Não (silenciado)" : "Não"}</span>}
                  </td>
                  <td className={`${tableCell} font-mono text-xs text-muted`}>{formatTime(k.stateChangedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>

      <section aria-labelledby="automations" className="flex flex-col gap-3">
        <SectionTitle id="automations">Automações</SectionTitle>
        <AutomationManager
          combinationId={id}
          automations={c.automations.map((a) => ({
            id: a.id,
            name: a.name,
            mode: a.mode,
            url: a.url,
            method: a.method,
            headers: a.headers,
            bodyTemplate: a.bodyTemplate,
            triggerStates: a.triggerStates,
            timeoutMs: a.timeoutMs,
            enabled: a.enabled,
          }))}
        />
        {c.runs.length > 0 && (
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <caption className="sr-only">Execuções de automação</caption>
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={tableHead}>Quando</th>
                  <th scope="col" className={tableHead}>Estado</th>
                  <th scope="col" className={tableHead}>Resultado</th>
                  <th scope="col" className={tableHead}>Detalhe</th>
                </tr>
              </thead>
              <tbody>
                {c.runs.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-b-0">
                    <td className={`${tableCell} font-mono text-xs text-muted`}>{formatTime(r.at)}</td>
                    <td className={tableCell}>{COMBINATION_STATE_META[r.triggerState as CombinationState].label}</td>
                    <td className={tableCell}><span className={cn("rounded-md border px-2 py-0.5 text-xs", RUN_TONE[r.status])}>{RUN_LABEL[r.status] ?? r.status}</span></td>
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
            {c.audit.map((a) => (
              <li key={a.id} className="border-b border-line px-5 py-3 text-sm last:border-b-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-xs text-muted">{formatTime(a.at)}</span>
                  <strong className="text-fg">{KIND_LABEL[a.kind] ?? a.kind}</strong>
                  <span className="text-muted">{a.actor}</span>
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
