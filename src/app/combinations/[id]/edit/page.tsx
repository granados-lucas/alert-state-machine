import Link from "next/link";
import { notFound } from "next/navigation";
import { CombinationForm } from "@/components/combination-form/combination-form";
import { linkClass, PageHeader } from "@/components/ui/ui";
import { getCombination } from "@/server/combination-queries";
import { database } from "@/server/runtime";

export const dynamic = "force-dynamic";

export default async function EditCombinationPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  const combination = await getCombination(database(), id);
  if (!combination) notFound();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-6 lg:px-8">
      <Link href={`/combinations/${id}`} className={`${linkClass} text-sm`}>← {combination.name}</Link>
      <PageHeader title="Editar combinação" subtitle="Salvar reavalia a combinação na hora com a regra nova. A alteração fica na auditoria. As automações são editadas na página da combinação." />
      <CombinationForm
        combination={{
          id,
          name: combination.name,
          description: combination.description,
          rule: combination.rule,
          minCount: combination.minCount,
          durationSeconds: combination.durationSeconds,
          components: combination.components.map((c) => ({ id: c.id, name: c.name })),
        }}
      />
    </main>
  );
}
