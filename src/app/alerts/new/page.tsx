import { AlertForm } from "@/components/alert-form/alert-form";
import { PageHeader } from "@/components/ui/ui";

export const metadata = { title: "Novo alerta · Global Alerts" };

export default function NewAlertPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-6 lg:px-8">
      <PageHeader
        title="Novo alerta"
        subtitle="Registra o monitor no Global Alerts antes do primeiro webhook, com remediação opcional. Monitores desconhecidos também são descobertos automaticamente quando o Datadog envia um evento. Este formulário não cria o monitor no Datadog."
      />
      <AlertForm />
    </main>
  );
}
