import { describe, expect, it } from "vitest";
import { ALERT_STATES, eventTo, transition } from "@/domain/alert-machine";
import {
  ALERT_TYPE_EQUIVALENCE,
  OVERALL_STATE_EQUIVALENCE,
  TRANSITION_EQUIVALENCE,
  eventFromOverallState,
  mapTransition,
  resolveOverallState,
} from "./states";

// Enum de overall_state da documentação da API de monitores do Datadog.
const DOCUMENTED = ["Alert", "Ignored", "No Data", "OK", "Skipped", "Unknown", "Warn"];

describe("equivalência de overall_state", () => {
  it("cobre exatamente os valores documentados do Datadog", () => {
    expect(Object.keys(OVERALL_STATE_EQUIVALENCE).sort()).toEqual([...DOCUMENTED].sort());
  });

  it.each([
    ["OK", "ok"],
    ["Warn", "warn"],
    ["Alert", "alert"],
    ["No Data", "no_data"],
    ["Unknown", "no_data"],
    ["Skipped", null],
    ["Ignored", null],
  ])("%s -> %s", (raw, state) => {
    expect(resolveOverallState(raw)).toMatchObject({ raw, state, recognized: true });
  });

  it("estado desconhecido ou ausente mantém o atual e explica o motivo", () => {
    expect(resolveOverallState("Maintenance")).toMatchObject({ state: null, recognized: false, reason: expect.stringContaining("Maintenance") });
    expect(resolveOverallState(null)).toMatchObject({ state: null, recognized: false });
    expect(eventFromOverallState("Skipped")).toBeNull();
    expect(eventFromOverallState(null)).toBeNull();
  });

  it("todo estado com equivalente leva, pela máquina, ao próprio estado", () => {
    for (const row of Object.values(OVERALL_STATE_EQUIVALENCE)) {
      if (!row.state) continue;
      const event = eventTo(row.state);
      const from = ALERT_STATES.find((s) => s !== row.state)!;
      expect(transition(from, event)).toMatchObject({ kind: "changed", to: row.state });
      expect(transition(row.state, event).kind).toBe("unchanged");
    }
  });

  it("todo estado interno é alcançável por algum estado do Datadog", () => {
    const reached = new Set(Object.values(OVERALL_STATE_EQUIVALENCE).map((r) => r.state));
    for (const state of ALERT_STATES) expect(reached.has(state)).toBe(true);
  });
});

describe("equivalência do webhook", () => {
  it("cada regra de transição produz o evento declarado", () => {
    for (const row of TRANSITION_EQUIVALENCE) expect(mapTransition(row.note, "")).toBe(row.event);
  });

  it("a primeira regra que combina vence e o tipo do alerta é o plano B", () => {
    expect(mapTransition("Recovered from No Data", "")).toBe("recovered");
    expect(mapTransition("", "ERROR")).toBe("triggered");
    for (const [type, event] of Object.entries(ALERT_TYPE_EQUIVALENCE)) expect(mapTransition("", type)).toBe(event);
    expect(mapTransition("Renotify", "info")).toBeNull();
  });
});
