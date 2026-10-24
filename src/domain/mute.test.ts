import { describe, expect, it } from "vitest";
import { isMuted, MUTE_MAX_MINUTES, muteUntil } from "./mute";

const now = new Date("2026-01-01T12:00:00Z");

describe("mute", () => {
  it("vale até o instante final e depois expira", () => {
    expect(isMuted(new Date("2026-01-01T12:00:01Z"), now)).toBe(true);
    expect(isMuted(new Date("2026-01-01T12:00:00Z"), now)).toBe(false);
    expect(isMuted(null, now)).toBe(false);
    expect(isMuted(undefined, now)).toBe(false);
  });

  it("calcula o fim a partir de minutos e limita a 7 dias", () => {
    expect(muteUntil(90, now).toISOString()).toBe("2026-01-01T13:30:00.000Z");
    expect(MUTE_MAX_MINUTES).toBe(10080);
  });
});
