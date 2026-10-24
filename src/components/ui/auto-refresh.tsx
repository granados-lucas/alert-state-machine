"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// Atualiza os dados do servidor sem recarregar a página (o estado do cliente, como zoom e seleção, é mantido).
export function AutoRefresh({ seconds = 5 }: { seconds?: number }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [enabled, seconds, router]);

  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
      <input type="checkbox" className="size-4 accent-accent" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
      Atualizar a cada {seconds}s
    </label>
  );
}
