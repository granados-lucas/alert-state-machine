import { describe, expect, it } from "vitest";
import {
  PRIORITY_WEIGHTS,
  byHealthAsc,
  effectiveState,
  emptyCounts,
  mergeBuckets,
  summarize,
  weightOf,
  type Bucket,
} from "./application-status";

const b = (state: Bucket["state"], priority: number | null, n = 1): Bucket => ({ state, priority, n });

describe("cor (pior estado)", () => {
  it("segue a ordem alert > warn > no_data > ok", () => {
    expect(summarize([b("ok", 1, 2), b("alert", 1)]).status).toBe("alert");
    expect(summarize([b("ok", 1, 5), b("warn", 1), b("no_data", 1, 3)]).status).toBe("warn");
    expect(summarize([b("ok", 1, 5), b("no_data", 1)]).status).toBe("no_data");
    expect(summarize([b("ok", 1)]).status).toBe("ok");
  });

  it("é null sem alertas ativos", () => {
    expect(summarize([]).status).toBeNull();
    expect(summarize([b("alert", 1, 0)]).status).toBeNull();
  });
});

describe("peso = prioridade", () => {
  it("usa escala exponencial e trata alerta sem prioridade (ou inválida) como P3", () => {
    expect([1, 2, 3, 4, 5].map((p) => PRIORITY_WEIGHTS[p])).toEqual([16, 8, 4, 2, 1]);
    expect(weightOf(1)).toBe(16);
    expect(weightOf(null)).toBe(4);
    expect(weightOf(9)).toBe(4);
  });

  it("rebaixa alert de P4/P5 para warn; P1 a P3 e sem prioridade continuam alert", () => {
    expect([1, 2, 3, null].map((p) => effectiveState("alert", p))).toEqual(["alert", "alert", "alert", "alert"]);
    expect([4, 5].map((p) => effectiveState("alert", p))).toEqual(["warn", "warn"]);
    expect(effectiveState("warn", 5)).toBe("warn");
    expect(effectiveState("no_data", 5)).toBe("no_data");
    expect(effectiveState("ok", 1)).toBe("ok");
  });
});

describe("summarize", () => {
  it("sem alertas não tem cor nem índice", () => {
    expect(summarize([])).toEqual({ counts: emptyCounts(), total: 0, status: null, health: null, downgraded: 0 });
    expect(summarize([b("alert", 1, 0)]).status).toBeNull();
  });

  it("um alerta P1 a P3 em alert deixa vermelho, mesmo entre muitos saudáveis", () => {
    const s = summarize([b("ok", 2, 40), b("alert", 3, 1)]);
    expect(s).toMatchObject({ status: "alert", total: 41, downgraded: 0, counts: { ok: 40, alert: 1 } });
  });

  it("alert de P4/P5 só deixa âmbar e é contado como rebaixado", () => {
    expect(summarize([b("ok", 1, 10), b("alert", 5, 2), b("alert", 4, 1)])).toMatchObject({ status: "warn", downgraded: 3, counts: { alert: 3 } });
    expect(summarize([b("alert", 5), b("alert", 2)]).status).toBe("alert");
  });

  it("calcula o índice ponderado pelo peso e arredonda", () => {
    expect(summarize([b("ok", 1, 3)]).health).toBe(100);
    expect(summarize([b("alert", 1)]).health).toBe(0);
    // P1 saudável (16) + P5 em alert (1): perda = 1/17
    expect(summarize([b("ok", 1), b("alert", 5)]).health).toBe(94);
    // P1 em alert (16) + P5 saudável (1): perda = 16/17
    expect(summarize([b("alert", 1), b("ok", 5)]).health).toBe(6);
    // no_data desconta 25%; warn, 50%
    expect(summarize([b("no_data", 2)]).health).toBe(75);
    expect(summarize([b("warn", null)]).health).toBe(50);
  });

  it("o mesmo alerta em alert pesa mais quanto mais alta a prioridade", () => {
    const base = [b("ok", 3, 4)];
    const p1 = summarize([...base, b("alert", 1)]).health!;
    const p5 = summarize([...base, b("alert", 5)]).health!;
    expect(p1).toBeLessThan(p5);
  });
});

describe("mergeBuckets e ordenação", () => {
  it("soma grupos iguais e mantém os diferentes", () => {
    const merged = mergeBuckets([[b("ok", 1, 2), b("alert", null)], [b("ok", 1, 3), b("alert", 5)]]);
    expect(merged).toHaveLength(3);
    expect(merged.find((x) => x.state === "ok")?.n).toBe(5);
  });

  it("pior índice primeiro; sem índice no fim", () => {
    expect([null, 90, 10].sort(byHealthAsc)).toEqual([10, 90, null]);
  });
});
