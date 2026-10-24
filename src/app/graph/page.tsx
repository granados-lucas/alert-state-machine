import type { Metadata } from "next";
import { AlertGraph } from "@/components/alert-graph/alert-graph";
import { PageHeader } from "@/components/ui/ui";

export const metadata: Metadata = { title: "Máquina de estados · Global Alerts" };

export default function GraphPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-6 lg:px-8">
      <PageHeader
        title="Máquina de estados"
        subtitle="Estados e transições de um alerta. Arraste os nós, use a roda do mouse para zoom e selecione um estado para destacar suas saídas."
      />
      <AlertGraph />
    </main>
  );
}
