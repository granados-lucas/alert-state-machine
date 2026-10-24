import { isMuted } from "@/domain/mute";
import { formatTime } from "@/lib/format";

// "Silenciado" nunca esconde o estado: o alerta continua contando na saúde da jornada.
export function MutedBadge({ mutedUntil }: { mutedUntil: Date | null }) {
  if (!isMuted(mutedUntil)) return null;
  return (
    <span className="ml-1 inline-flex items-center rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted" title={`Silenciado até ${formatTime(mutedUntil)}`}>
      Silenciado
    </span>
  );
}
