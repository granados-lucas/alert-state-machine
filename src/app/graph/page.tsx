import type { Metadata } from "next";
import { AlertGraph } from "@/components/alert-graph/alert-graph";
import { StateBadge } from "@/components/state-badge";
import { Card, PageHeader, SectionTitle, tableCell, tableHead } from "@/components/ui/ui";
import { listProviderInfo } from "@/providers/catalog";

export const metadata: Metadata = { title: "Máquina de estados · Global Alerts" };

export default function GraphPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-6 lg:px-8">
      <PageHeader
        title="Máquina de estados"
        subtitle="Estados e transições de um alerta. Arraste os nós, use a roda do mouse para zoom e selecione um estado para destacar suas saídas."
      />
      <AlertGraph />

      <section aria-labelledby="equivalence" className="flex flex-col gap-3">
        <SectionTitle id="equivalence">Equivalência de estados por fonte</SectionTitle>
        <p className="text-sm text-muted">
          Como o estado informado por cada fonte vira o estado desta aplicação. Estados sem equivalente <strong>mantêm</strong> o estado atual.
          Fonte única: <code>src/providers/&lt;fonte&gt;/</code>. Nenhuma fonte foi validada contra o sistema real (ver <code>docs/integrations</code>).
        </p>
        {listProviderInfo().map((p) => (
          <Card key={p.id} className="flex flex-col gap-3 p-0">
            <h3 className="px-4 pt-4 text-base font-semibold">{p.label}</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Equivalência entre os estados de {p.label} e os desta aplicação</caption>
                <thead>
                  <tr className="border-b border-line">
                    <th scope="col" className={tableHead}>{p.label} · <span className="font-mono font-normal">{p.sourceField}</span></th>
                    <th scope="col" className={tableHead}>Aqui</th>
                    <th scope="col" className={tableHead}>Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {p.rows.map((row) => (
                    <tr key={row.raw} className="border-b border-line last:border-b-0">
                      <td className={`${tableCell} font-mono`}>{row.raw}</td>
                      <td className={tableCell}>{row.state ? <StateBadge state={row.state} /> : <span className="text-muted">mantém o atual</span>}</td>
                      <td className={`${tableCell} text-muted`}>{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="list-disc space-y-1 px-4 pb-4 pl-8 text-sm text-muted">
              <li>Autenticação do webhook: {p.auth} (segredo em <code>{p.secretEnv}</code>).</li>
              {p.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          </Card>
        ))}
      </section>
    </main>
  );
}
