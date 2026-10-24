import { describe, expect, it } from "vitest";
import { emptyCounts, worstState } from "./application-status";

describe("worstState", () => {
  it("fica em alert se ao menos um alerta estiver em alert", () => {
    expect(worstState({ ok: 2, alert: 1 })).toBe("alert");
  });

  it("segue a ordem alert > warn > no_data > ok", () => {
    expect(worstState({ ok: 5, warn: 1, no_data: 3 })).toBe("warn");
    expect(worstState({ ok: 5, no_data: 1 })).toBe("no_data");
    expect(worstState({ ok: 1 })).toBe("ok");
  });

  it("retorna null sem alertas ativos", () => {
    expect(worstState(emptyCounts())).toBeNull();
    expect(worstState({})).toBeNull();
  });
});
