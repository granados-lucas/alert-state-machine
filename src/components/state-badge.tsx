import type { AlertState } from "@/domain/alert-machine";
import { STATE_META } from "@/components/alert-graph/meta";
import { cn } from "@/lib/utils";

// Pílula com ponto + texto: o estado nunca depende só da cor.
export function StateBadge({ state }: { state: AlertState }) {
  const meta = STATE_META[state];
  return (
    <span className={cn("inline-flex min-w-[4.75rem] items-center justify-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium", meta.tone)}>
      <span aria-hidden className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </span>
  );
}
