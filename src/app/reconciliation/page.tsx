import Link from "next/link";
import { ReconcileControl } from "@/components/reconciliation/reconcile-control";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { Card, PageHeader, SectionTitle, linkClass } from "@/components/ui/ui";
import { getDatadogApiConfig } from "@/lib/env";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { listReconciliationRuns } from "@/server/reconcile";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reconciliação · Global Alerts" };

const STATUS: Record<string, { label: string; tone: string }> = {
  running: { label: "Em andamento", tone: "border-info/40 bg-info/10 text-info" },
  succeeded: { label: "Concluída", tone: "border-ok/30 bg-ok/10 text-ok" },
  partial: { label: "Parcial", tone: "border-warn/35 bg-warn/10 text-warn" },
  failed: { label: "Falhou", tone: "border-alert/40 bg-alert/10 text-alert-fg" },
};
const ACTION: Record<string, string> = { corrected: "corrigido", created: "criado", kept: "mantido", missing: "ausente no Datadog", stale: "dado antigo descartado" };

type Summary = Record<string, number> & { details?: { externalId: string; name: string; action: string; from?: string; to?: string; raw?: string | null }[] };

export default async function ReconciliationPage() {
  const runs = await listReconciliationRuns(database(), 15);
  const running = runs.some((r) => r.status === "running");
  const enabled = getDatadogApiConfig() !== undefined;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-6 lg:px-8">
      <PageHeader
        title="Reconciliação"
        subtitle="Compara o estado de cada alerta com o estado real do monitor no Datadog e corrige o que ficou diferente (webhook perdido, monitor silenciado, alerta recém-importado)."
        actions={running ? <AutoRefresh seconds={3} /> : <AutoRefresh seconds={15} />}
      />

      <Card className="flex flex-col gap-4">
        <SectionTitle>Nova execução</SectionTitle>
        <ReconcileControl enabled={enabled} running={running} />
        <p className="max-w-3xl text-xs text-muted">
          A leitura respeita o limite de uso da API do Datadog: os números de cada endpoint não são publicados, então a aplicação lê os cabeçalhos
          <code> X-RateLimit-*</code> de cada resposta, espera o reset quando recebe 429 (até 5 vezes por página, no máximo 120 s cada) e para depois de 10 minutos.
          Estados do Datadog sem equivalente (Skipped, Ignored) mantêm o estado atual; ver <Link className={linkClass} href="/graph">a tabela de equivalência</Link>.
          Para rodar periodicamente use <code>scripts/reconcile.mjs --every 300</code> (veja o README).
        </p>
      </Card>

      <section aria-labelledby="runs" className="flex flex-col gap-3">
        <SectionTitle id="runs">Execuções recentes</SectionTitle>
        {runs.length === 0 ? (
          <p className="text-muted">Nenhuma execução ainda.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {runs.map((r) => {
              const s = r.summary as Summary;
              const st = STATUS[r.status] ?? STATUS.failed;
              const seconds = r.finishedAt ? Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000) : null;
              const rl = r.rateLimit as { limit?: number; period?: number; remaining?: number; name?: string };
              return (
                <Card key={r.id} className="flex flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                    <span className={cn("rounded-md border px-2 py-0.5 text-xs font-medium", st.tone)}>{st.label}</span>
                    {r.dryRun && <span className="rounded-md border border-line px-2 py-0.5 text-xs text-muted">simulação</span>}
                    <span className="font-mono text-xs text-muted">#{r.id} · {formatTime(r.startedAt)}{seconds !== null && ` · ${seconds}s`}</span>
                    <span className="text-muted">{r.trigger === "schedule" ? "agendada" : "manual"} · {r.actor}</span>
                  </div>
                  {r.status !== "running" || s.seen ? (
                    <p className="text-sm">
                      {s.seen ?? 0} monitores lidos em {s.pages ?? 0} páginas · <strong>{s.corrected ?? 0}</strong> corrigidos · <strong>{s.created ?? 0}</strong> criados · {s.inSync ?? 0} em dia · {s.kept ?? 0} mantidos · {s.missing ?? 0} ausentes
                      {(s.stale ?? 0) > 0 && ` · ${s.stale} descartados por webhook mais novo`}
                      {(s.rateLimited ?? 0) > 0 && ` · ${s.rateLimited}× limite de uso (429) absorvido`}
                    </p>
                  ) : null}
                  {r.error && <p className="text-sm text-alert-fg">{r.error}</p>}
                  {rl.limit !== undefined && (
                    <p className="text-xs text-muted">Limite visto: {rl.limit} por {rl.period}s{rl.name ? ` (${rl.name})` : ""}; restavam {rl.remaining}.</p>
                  )}
                  {s.details && s.details.length > 0 && (
                    <details>
                      <summary className="cursor-pointer text-xs text-accent-soft">detalhes ({s.details.length}{s.details.length === 100 ? "+" : ""})</summary>
                      <ul className="mt-2 flex flex-col gap-1 text-xs">
                        {s.details.map((d) => (
                          <li key={`${d.action}-${d.externalId}`} className="flex flex-wrap gap-x-2">
                            <span className="w-40 shrink-0 text-muted">{ACTION[d.action] ?? d.action}</span>
                            <span className="font-medium">{d.name}</span>
                            <span className="text-muted">{d.from ? `${d.from} → ` : ""}{d.to ?? ""}{d.raw ? ` (Datadog: ${d.raw})` : ""}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
