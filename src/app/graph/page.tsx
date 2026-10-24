import type { Metadata } from "next";
import { AlertGraph } from "@/components/alert-graph/alert-graph";
import { StateBadge } from "@/components/state-badge";
import { Card, PageHeader, SectionTitle, tableCell, tableHead } from "@/components/ui/ui";
import { ALERT_TYPE_EQUIVALENCE, OVERALL_STATE_EQUIVALENCE, TRANSITION_EQUIVALENCE } from "@/providers/datadog/states";

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
        <SectionTitle id="equivalence">Equivalência com o Datadog</SectionTitle>
        <p className="text-sm text-muted">
          Como o estado informado pelo Datadog (campo <code>overall_state</code> da API, usado ao silenciar e na reconciliação) vira o estado desta aplicação.
          Estados sem equivalente <strong>mantêm</strong> o estado atual. Fonte única: <code>src/providers/datadog/states.ts</code>.
        </p>
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <caption className="sr-only">Equivalência entre os estados do Datadog e os desta aplicação</caption>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className={tableHead}>Datadog</th>
                <th scope="col" className={tableHead}>Aqui</th>
                <th scope="col" className={tableHead}>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(OVERALL_STATE_EQUIVALENCE).map(([raw, row]) => (
                <tr key={raw} className="border-b border-line last:border-b-0">
                  <td className={`${tableCell} font-mono`}>{raw}</td>
                  <td className={tableCell}>{row.state ? <StateBadge state={row.state} /> : <span className="text-muted">mantém o atual</span>}</td>
                  <td className={`${tableCell} text-muted`}>{row.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <p className="text-sm text-muted">
          Webhook: o texto da transição (<code>$ALERT_TRANSITION</code>) é reconhecido por{" "}
          {TRANSITION_EQUIVALENCE.map((r) => `"${r.contains}" → ${r.event}`).join(", ")}; sem transição reconhecida vale o tipo (<code>$ALERT_TYPE</code>):{" "}
          {Object.entries(ALERT_TYPE_EQUIVALENCE).map(([k, v]) => `${k} → ${v}`).join(", ")}.
        </p>
      </section>
    </main>
  );
}
