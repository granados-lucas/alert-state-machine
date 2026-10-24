import { JourneyForm } from "@/components/journey-form/journey-form";
import { PageHeader } from "@/components/ui/ui";
import { listApplicationNames } from "@/server/queries";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const metadata = { title: "Nova jornada · Global Alerts" };

export default async function NewJourneyPage() {
  const applications = await listApplicationNames(database());
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-6 lg:px-8">
      <PageHeader
        title="Nova jornada"
        subtitle="Uma jornada agrupa as aplicações de um fluxo de negócio. A saúde dela é o pior estado entre os alertas dessas aplicações."
      />
      <JourneyForm allApplications={applications} />
    </main>
  );
}
