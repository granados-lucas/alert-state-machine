/** Limites do silêncio: sempre com prazo (um silêncio esquecido esconde incidentes de verdade). */
export const MUTE_MIN_MINUTES = 1;
export const MUTE_MAX_MINUTES = 7 * 24 * 60;

/** Um silêncio vale até `mutedUntil`; o provedor o encerra sozinho nesse instante. */
export function isMuted(mutedUntil: Date | null | undefined, now: Date = new Date()): boolean {
  return mutedUntil != null && mutedUntil.getTime() > now.getTime();
}

export function muteUntil(minutes: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + minutes * 60_000);
}
