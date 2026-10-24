"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { btnPrimary, field } from "@/components/ui/ui";
import { cn } from "@/lib/utils";

type Props = { enabled: boolean; running: boolean };

export function ReconcileControl({ enabled, running }: Props) {
  const router = useRouter();
  const [dryRun, setDryRun] = useState(true);
  const [createMissing, setCreateMissing] = useState(true);
  const [remediate, setRemediate] = useState(true);
  const [tags, setTags] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || running) return;
    setPending(true);
    setErrors([]);
    try {
      const response = await fetch("/api/reconciliation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun, createMissing, remediate, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setErrors(data.issues ? data.issues.map((i: { path: string; message: string }) => `${i.path || "corpo"}: ${i.message}`) : [data.error ?? `Erro ${response.status}`]);
        return;
      }
      router.refresh();
    } catch {
      setErrors(["Não foi possível falar com o servidor."]);
    } finally {
      setPending(false);
    }
  }

  const box = "flex cursor-pointer items-center gap-2 text-sm text-muted";
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <label className={box}>
          <input type="checkbox" className="size-4 accent-accent" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          Só simular (não altera nada)
        </label>
        <label className={box}>
          <input type="checkbox" className="size-4 accent-accent" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />
          Criar alertas de monitores novos
        </label>
        <label className={box}>
          <input type="checkbox" className="size-4 accent-accent" checked={remediate} onChange={(e) => setRemediate(e.target.checked)} />
          Executar remediações dos alertas corrigidos
        </label>
      </div>
      <label className="flex max-w-xl flex-col gap-1.5 text-sm text-muted">
        Filtrar por tags do Datadog (opcional, separadas por vírgula)
        <input className={field} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="service:checkout" />
      </label>
      {errors.length > 0 && (
        <ul role="alert" className="list-disc rounded-2xl border border-alert/40 bg-alert/10 p-4 pl-8 text-sm text-alert-fg">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      <button type="submit" disabled={!enabled || pending || running} className={cn(btnPrimary, "self-start")}>
        {running ? "Há uma execução em andamento…" : pending ? "Iniciando…" : dryRun ? "Simular reconciliação" : "Reconciliar agora"}
      </button>
      {!enabled && <p className="text-sm text-muted">Indisponível: configure <code>DD_API_KEY</code> e <code>DD_APP_KEY</code> (permissão <code>monitors_read</code>) no servidor.</p>}
    </form>
  );
}
