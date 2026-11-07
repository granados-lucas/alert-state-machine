import { CombinationForm } from "@/components/combination-form/combination-form";
import { PageHeader } from "@/components/ui/ui";

export const metadata = { title: "Nova combinação · Global Alerts" };

export default function NewCombinationPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-6 lg:px-8">
      <PageHeader
        title="Nova combinação"
        subtitle="Escolha os alertas que já existem, a regra e por quanto tempo ela precisa valer. A combinação tem estado próprio e pode acionar uma automação; ela não muda o mapa de jornadas nem a saúde."
      />
      <CombinationForm />
    </main>
  );
}
