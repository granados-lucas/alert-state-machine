import type { Metadata } from "next";
import Link from "next/link";
import { Card, PageHeader, SectionTitle, linkClass } from "@/components/ui/ui";
import { DOCS, DOC_GROUPS } from "@/server/docs";

export const metadata: Metadata = { title: "Documentação · Global Alerts" };

const EVENT = `curl -X POST https://<endereço-do-global-alerts>/api/webhooks \\
  -H "x-webhook-secret: <WEBHOOK_SECRET>" -H "content-type: application/json" \\
  -d '{"source":"generic","event_id":"e1","monitor_id":"m1","monitor_name":"Teste","state":"alert","application":"demo"}'`;

export default function DocsPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-6 lg:px-8">
      <PageHeader
        title="Documentação"
        subtitle="Manual de uso e guias de integração do Global Alerts. O conteúdo vem dos arquivos Markdown do repositório, então esta página sempre acompanha a versão em execução."
      />

      <Card className="flex flex-col gap-3">
        <SectionTitle>Integração em resumo</SectionTitle>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>Defina o <code className="font-mono text-xs">WEBHOOK_SECRET</code> na aplicação (um segredo só, para qualquer ferramenta).</li>
          <li>Na ferramenta de monitoramento, aponte o webhook para <code className="font-mono text-xs">POST /api/webhooks</code> com o segredo no cabeçalho <code className="font-mono text-xs">X-Webhook-Secret</code>.</li>
          <li>Informe a fonte no corpo (<code className="font-mono text-xs">&quot;source&quot;: &quot;datadog&quot;</code>, <code className="font-mono text-xs">appdynamics</code> ou <code className="font-mono text-xs">generic</code>); o CloudWatch dispensa o campo.</li>
          <li>Para trocar de ferramenta, mude só o modelo de payload dela: a URL e o segredo continuam os mesmos.</li>
        </ol>
        <p className="text-xs text-muted">Teste rápido, sem nenhuma ferramenta:</p>
        <pre className="overflow-x-auto rounded-xl border border-line bg-bg p-3 font-mono text-xs leading-relaxed">{EVENT}</pre>
        <p className="text-xs text-muted">
          Os adaptadores de CloudWatch, AppDynamics e genérico foram escritos a partir da documentação das ferramentas e ainda não foram validados com elas.{" "}
          <Link className={linkClass} href="/docs/manual">Veja o manual</Link>.
        </p>
      </Card>

      {DOC_GROUPS.map((group) => (
        <section key={group} aria-labelledby={`group-${group}`} className="flex flex-col gap-3">
          <SectionTitle id={`group-${group}`}>{group}</SectionTitle>
          <ul className="grid gap-3 sm:grid-cols-2">
            {DOCS.filter((d) => d.group === group).map((d) => (
              <li key={d.slug}>
                <Link href={`/docs/${d.slug}`} className="block h-full rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-accent/50 hover:bg-surface-2">
                  <span className="font-semibold text-fg">{d.title}</span>
                  <span className="mt-1 block text-sm text-muted">{d.description}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
