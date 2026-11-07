import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import type { NormalizedEvent } from "@/providers/types";
import { evaluateCombinations } from "./combination-evaluator";
import { createCombination, createCombinationSchema } from "./combinations";
import type { Db } from "./db-types";
import { ingestEvent } from "./ingest";

// O mock encapsula a função real: cada teste decide se a próxima chamada falha.
vi.mock("./combination-evaluator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./combination-evaluator")>();
  return { ...actual, evaluateCombinations: vi.fn(actual.evaluateCombinations) };
});

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

let seq = 0;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const ev = (externalAlertId: string, event: NormalizedEvent["event"], at = ++seq): NormalizedEvent => ({
  provider: "datadog",
  externalEventId: `evt-${externalAlertId}-${at}-${Math.random().toString(36).slice(2, 6)}`,
  externalAlertId,
  alertName: externalAlertId,
  application: "combos",
  event,
  occurredAt: new Date(T0 + at * 1000),
  priority: 2,
  tags: [],
  link: null,
  raw: {},
});

async function combinationOver(externalId: string) {
  const first = await ingestEvent(db, ev(externalId, "recovered"));
  if (first.status !== "processed") throw new Error("esperava processed");
  const { combination } = await createCombination(
    db,
    createCombinationSchema.parse({
      name: `c-${externalId}`,
      rule: "and",
      alertIds: [first.alertId],
      automations: [{ name: "a", mode: "webhook", url: "http://hooks.test/x" }],
    }),
    "t",
  );
  return { combination, alertId: first.alertId };
}

describe("ingestEvent e combinações", () => {
  it("o evento que leva o componente a alert devolve a automação da combinação", async () => {
    const { combination } = await combinationOver("comb-1");
    expect(combination.state).toBe("ok");
    const result = await ingestEvent(db, ev("comb-1", "triggered"));
    if (result.status !== "processed") throw new Error();
    expect(result.outcome).toBe("applied");
    expect(result.combinations).toHaveLength(1);
    expect(result.combinations[0]).toMatchObject({ combinationId: combination.id, state: "alert", previousState: "ok" });
  });

  it("evento unchanged ou stale não avalia nem devolve nada", async () => {
    await combinationOver("comb-2");
    await ingestEvent(db, ev("comb-2", "triggered", 500));
    vi.mocked(evaluateCombinations).mockClear();
    const unchanged = await ingestEvent(db, ev("comb-2", "triggered", 600));
    const stale = await ingestEvent(db, ev("comb-2", "recovered", 100));
    expect(unchanged).toMatchObject({ outcome: "unchanged", combinations: [] });
    expect(stale).toMatchObject({ outcome: "stale", combinations: [] });
    expect(evaluateCombinations).not.toHaveBeenCalled();
  });

  it("falha do avaliador não derruba o evento já gravado", async () => {
    await combinationOver("comb-3");
    vi.mocked(evaluateCombinations).mockRejectedValueOnce(new Error("boom"));
    const result = await ingestEvent(db, ev("comb-3", "triggered"));
    expect(result).toMatchObject({ status: "processed", outcome: "applied", to: "alert", combinations: [] });
  });

  it("duplicata continua respondendo duplicate", async () => {
    const event = ev("comb-4", "triggered");
    await ingestEvent(db, event);
    expect(await ingestEvent(db, event)).toEqual({ status: "duplicate" });
  });
});
