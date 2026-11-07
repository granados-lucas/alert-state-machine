import type { CombinationState } from "@/domain/combination";
import { cn } from "@/lib/utils";

export const COMBINATION_STATE_META: Record<CombinationState, { label: string; tone: string; dot: string }> = {
  ok: { label: "Normal", tone: "border-ok/30 bg-ok/10 text-ok", dot: "bg-ok" },
  pending: { label: "Armando", tone: "border-warn/35 bg-warn/10 text-warn", dot: "bg-warn" },
  alert: { label: "Alerta", tone: "border-alert/40 bg-alert/10 text-alert-fg", dot: "bg-alert" },
};

// Pílula com ponto + texto: o estado nunca depende só da cor.
export function CombinationStateBadge({ state }: { state: CombinationState }) {
  const meta = COMBINATION_STATE_META[state];
  return (
    <span className={cn("inline-flex min-w-[4.75rem] items-center justify-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium", meta.tone)}>
      <span aria-hidden className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </span>
  );
}
