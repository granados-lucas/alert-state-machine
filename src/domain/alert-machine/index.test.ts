import { describe, expect, it } from "vitest";
import { ALERT_EVENTS, ALERT_STATES, listEdges, transition, type AlertEvent } from "./index";

describe("transition", () => {
  it("muda de estado quando o evento leva a outro estado", () => {
    expect(transition("ok", "triggered")).toEqual({ kind: "changed", from: "ok", to: "alert", event: "triggered" });
    expect(transition("alert", "recovered")).toEqual({ kind: "changed", from: "alert", to: "ok", event: "recovered" });
  });

  it("não muda quando o evento repete o estado atual", () => {
    expect(transition("alert", "triggered")).toEqual({ kind: "unchanged", state: "alert" });
  });

  it("rejeita evento desconhecido sem alterar o estado", () => {
    expect(transition("ok", "bogus" as AlertEvent)).toEqual({ kind: "rejected", state: "ok", event: "bogus" });
  });

  it("cobre todos os pares estado/evento sem lacunas", () => {
    for (const state of ALERT_STATES) {
      for (const event of ALERT_EVENTS) {
        expect(transition(state, event).kind).not.toBe("rejected");
      }
    }
  });
});

describe("listEdges", () => {
  it("lista cada transição permitida uma vez", () => {
    const edges = listEdges();
    expect(edges).toHaveLength(ALERT_STATES.length * (ALERT_EVENTS.length - 1));
    expect(edges).toContainEqual({ from: "no_data", event: "warned", to: "warn" });
  });
});
