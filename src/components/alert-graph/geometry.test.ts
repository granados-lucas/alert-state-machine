import { describe, expect, it } from "vitest";
import { edgeSegment, placeLabels } from "./geometry";

const size = { width: 160, height: 64 };

describe("edgeSegment", () => {
  it("sai e entra pelas bordas, não pelos centros", () => {
    const s = edgeSegment({ x: 0, y: 0 }, { x: 400, y: 0 }, size, 0)!;
    expect(s.start.x).toBeCloseTo(83);
    expect(s.end.x).toBeCloseTo(317);
  });

  it("separa ida e volta em lados opostos", () => {
    const ida = edgeSegment({ x: 0, y: 0 }, { x: 400, y: 0 }, size, 12)!;
    const volta = edgeSegment({ x: 400, y: 0 }, { x: 0, y: 0 }, size, 12)!;
    expect(ida.mid.y).toBeCloseTo(12);
    expect(volta.mid.y).toBeCloseTo(-12);
  });

  it("ignora nós sobrepostos", () => {
    expect(edgeSegment({ x: 1, y: 1 }, { x: 1, y: 1 }, size, 12)).toBeNull();
  });
});

describe("placeLabels", () => {
  it("afasta rótulos de segmentos que se sobrepõem", () => {
    const seg = { start: { x: 0, y: 0 }, end: { x: 300, y: 0 } };
    const [a, b] = placeLabels([seg, seg], { width: 80, height: 20 }, []);
    expect(Math.abs(a - b)).toBeGreaterThan(0.2);
  });

  it("evita colocar o rótulo em cima de um nó", () => {
    const seg = { start: { x: 0, y: 0 }, end: { x: 300, y: 0 } };
    const [t] = placeLabels([seg], { width: 60, height: 20 }, [{ x: 120, y: -30, width: 60, height: 60 }]);
    expect(t).not.toBeCloseTo(0.5);
  });
});
