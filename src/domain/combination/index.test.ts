import { describe, expect, it } from "vitest";
import { nextState, ruleMet } from "./index";

const at = (time: string) => new Date(`2026-01-01T${time}Z`);

describe("ruleMet", () => {
  it("and exige todos e pelo menos um componente", () => {
    expect(ruleMet({ rule: "and", minCount: null }, 2, 2)).toBe(true);
    expect(ruleMet({ rule: "and", minCount: null }, 1, 2)).toBe(false);
    expect(ruleMet({ rule: "and", minCount: null }, 0, 0)).toBe(false);
  });

  it("or exige pelo menos um", () => {
    expect(ruleMet({ rule: "or", minCount: null }, 1, 3)).toBe(true);
    expect(ruleMet({ rule: "or", minCount: null }, 0, 3)).toBe(false);
  });

  it("at_least exige N ou mais", () => {
    expect(ruleMet({ rule: "at_least", minCount: 2 }, 2, 3)).toBe(true);
    expect(ruleMet({ rule: "at_least", minCount: 2 }, 3, 3)).toBe(true);
    expect(ruleMet({ rule: "at_least", minCount: 2 }, 1, 3)).toBe(false);
  });

  it("at_least sem minCount é erro de configuração", () => {
    expect(() => ruleMet({ rule: "at_least", minCount: null }, 1, 3)).toThrow();
  });
});

describe("nextState", () => {
  const now = at("10:02:00");

  it("ok com regra satisfeita e duração 0 vai direto para alert", () => {
    expect(nextState({ state: "ok", satisfiedSince: null, met: true, durationSeconds: 0, now })).toEqual({
      state: "alert",
      satisfiedSince: now,
      changed: true,
    });
  });

  it("ok com regra satisfeita e duração > 0 fica pending", () => {
    expect(nextState({ state: "ok", satisfiedSince: null, met: true, durationSeconds: 120, now })).toEqual({
      state: "pending",
      satisfiedSince: now,
      changed: true,
    });
  });

  it("ok com regra falsa não muda", () => {
    expect(nextState({ state: "ok", satisfiedSince: null, met: false, durationSeconds: 120, now })).toEqual({
      state: "ok",
      satisfiedSince: null,
      changed: false,
    });
  });

  it("pending vira alert quando a duração se cumpre e mantém o início", () => {
    const since = at("10:00:00");
    expect(nextState({ state: "pending", satisfiedSince: since, met: true, durationSeconds: 120, now })).toEqual({
      state: "alert",
      satisfiedSince: since,
      changed: true,
    });
  });

  it("pending continua pending antes da duração", () => {
    const since = at("10:00:30");
    expect(nextState({ state: "pending", satisfiedSince: since, met: true, durationSeconds: 120, now })).toEqual({
      state: "pending",
      satisfiedSince: since,
      changed: false,
    });
  });

  it("pending volta a ok e zera a contagem quando a regra deixa de valer", () => {
    expect(nextState({ state: "pending", satisfiedSince: at("10:00:30"), met: false, durationSeconds: 120, now })).toEqual({
      state: "ok",
      satisfiedSince: null,
      changed: true,
    });
  });

  it("alert com regra satisfeita não muda e mantém o início", () => {
    const since = at("10:00:00");
    expect(nextState({ state: "alert", satisfiedSince: since, met: true, durationSeconds: 120, now })).toEqual({
      state: "alert",
      satisfiedSince: since,
      changed: false,
    });
  });

  it("alert volta a ok quando a regra deixa de valer", () => {
    expect(nextState({ state: "alert", satisfiedSince: at("10:00:00"), met: false, durationSeconds: 120, now })).toEqual({
      state: "ok",
      satisfiedSince: null,
      changed: true,
    });
  });

  it("um componente com duração 300 passa por pending e só vira alert aos 300 s", () => {
    const config = { rule: "and", minCount: null } as const;
    const start = at("10:00:00");
    const first = nextState({ state: "ok", satisfiedSince: null, met: ruleMet(config, 1, 1), durationSeconds: 300, now: start });
    expect(first.state).toBe("pending");
    const early = nextState({ ...first, met: true, durationSeconds: 300, now: at("10:04:59") });
    expect(early.state).toBe("pending");
    const done = nextState({ ...early, met: true, durationSeconds: 300, now: at("10:05:00") });
    expect(done.state).toBe("alert");
  });

  it("quando o componente cai e volta, a contagem recomeça do instante da volta", () => {
    const dropped = nextState({ state: "pending", satisfiedSince: at("10:00:00"), met: false, durationSeconds: 120, now: at("10:01:00") });
    expect(dropped.state).toBe("ok");
    const back = nextState({ ...dropped, met: true, durationSeconds: 120, now: at("10:02:00") });
    expect(back).toEqual({ state: "pending", satisfiedSince: at("10:02:00"), changed: true });
  });
});
