export type Point = { x: number; y: number };
export type Size = { width: number; height: number };

const GAP = 3;

// Ponto onde a reta que sai do centro (deslocada por q) cruza a borda do retângulo, na direção u.
function exitPoint(center: Point, size: Size, q: Point, u: Point): Point {
  const tx = u.x === 0 ? Infinity : (Math.sign(u.x) * (size.width / 2 + GAP) - q.x) / u.x;
  const ty = u.y === 0 ? Infinity : (Math.sign(u.y) * (size.height / 2 + GAP) - q.y) / u.y;
  const t = Math.min(tx, ty);
  return { x: center.x + q.x + u.x * t, y: center.y + q.y + u.y * t };
}

// Aresta reta entre as bordas de dois nós, deslocada para a direita do sentido de viagem:
// A→B e B→A ficam em paralelo, sem se sobrepor.
export function edgeSegment(from: Point, to: Point, size: Size, offset: number) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;
  const u = { x: dx / length, y: dy / length };
  const q = { x: -u.y * offset, y: u.x * offset };
  const start = exitPoint(from, size, q, u);
  const end = exitPoint(to, size, { x: q.x, y: q.y }, { x: -u.x, y: -u.y });
  return { start, end, mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } };
}

type Rect = { x: number; y: number; width: number; height: number };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Escolhe, para cada segmento, a fração (0..1) ao longo da reta onde o rótulo colide menos com os
 * rótulos já posicionados e com os nós. Guloso e determinístico; vale para as posições iniciais.
 */
export function placeLabels(segments: { start: Point; end: Point }[], label: Size, avoid: Rect[]) {
  const placed: Rect[] = [];
  return segments.map((seg) => {
    let best = 0.5;
    let bestScore = Infinity;
    for (let t = 0.2; t <= 0.801; t += 0.05) {
      const x = seg.start.x + (seg.end.x - seg.start.x) * t - label.width / 2;
      const y = seg.start.y + (seg.end.y - seg.start.y) * t - label.height / 2;
      const rect = { x, y, width: label.width, height: label.height };
      const score = placed.filter((p) => overlaps(p, rect)).length * 10 + avoid.filter((n) => overlaps(n, rect)).length * 10 + Math.abs(t - 0.5);
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    placed.push({
      x: seg.start.x + (seg.end.x - seg.start.x) * best - label.width / 2,
      y: seg.start.y + (seg.end.y - seg.start.y) * best - label.height / 2,
      width: label.width,
      height: label.height,
    });
    return best;
  });
}
