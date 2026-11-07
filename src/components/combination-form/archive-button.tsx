"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { btnSecondary } from "@/components/ui/ui";

/** Arquiva (ou restaura) a combinação; o histórico e a auditoria ficam. */
export function ArchiveButton({ combinationId, archived }: { combinationId: number; archived: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/combinations/${combinationId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: !archived }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.error ?? `Erro ${response.status}`);
        return;
      }
      router.refresh();
    } catch {
      setError("Não foi possível falar com o servidor.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className={btnSecondary} disabled={pending} onClick={() => void toggle()}>
        {archived ? "Restaurar" : "Arquivar"}
      </button>
      {error && <p role="alert" className="text-xs text-alert-fg">{error}</p>}
    </div>
  );
}
