import Link from "next/link";
import { notFound } from "next/navigation";
import { JourneyForm } from "@/components/journey-form/journey-form";
import { PageHeader, linkClass } from "@/components/ui/ui";
import { getJourneyDetail, listApplicationNames } from "@/server/queries";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

export default async function EditJourneyPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  const db = database();
  const [detail, applications] = await Promise.all([getJourneyDetail(db, id), listApplicationNames(db)]);
  if (!detail) notFound();
  const { journey } = detail;
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-6 lg:px-8">
      <Link href={`/journeys/${id}`} className={`${linkClass} text-sm`}>← {journey.name}</Link>
      <PageHeader title="Editar jornada" subtitle="Trocar as aplicações muda a saúde da jornada imediatamente. A alteração fica na auditoria." />
      <JourneyForm
        allApplications={applications}
        journey={{ id, name: journey.name, description: journey.description, applications: journey.applications.map((a) => a.name) }}
      />
    </main>
  );
}
