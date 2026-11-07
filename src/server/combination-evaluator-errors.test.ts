import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { alerts, applications, combinationAlerts, combinations } from "@/db/schema";
import { createTestDb } from "@/test/db";
import { addAutomation, combinationAutomationSchema, findTriggeredAutomations } from "./combination-automations";
import { evaluateCombinations } from "./combination-evaluator";
import type { Db } from "./db-types";

// O mock encapsula a função real: o teste decide qual combinação falha ao buscar as automações.
vi.mock("./combination-automations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./combination-automations")>();
  return { ...actual, findTriggeredAutomations: vi.fn(actual.findTriggeredAutomations) };
});

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

async function alertingCombination(name: string, appId: number) {
  const [alert] = await db.insert(alerts).values({ applicationId: appId, provider: "datadog", externalId: name, name, state: "alert" }).returning({ id: alerts.id });
  const [combo] = await db.insert(combinations).values({ name, rule: "or" }).returning();
  await db.insert(combinationAlerts).values({ combinationId: combo.id, alertId: alert.id });
  await addAutomation(db, combo.id, combinationAutomationSchema.parse({ name: "a", mode: "webhook", url: "http://hooks.test/x" }), "t");
  return combo;
}

describe("falha isolada por combinação", () => {
  it("uma combinação que falha não descarta as automações das que já commitaram", async () => {
    const [app] = await db.insert(applications).values({ name: "falhas" }).returning({ id: applications.id });
    const first = await alertingCombination("primeira", app.id);
    const second = await alertingCombination("segunda", app.id);
    const real = vi.mocked(findTriggeredAutomations).getMockImplementation()!;
    vi.mocked(findTriggeredAutomations).mockImplementation(async (database, combinationId, state) => {
      if (combinationId === second.id) throw new Error("falha transitória");
      return real(database, combinationId, state);
    });

    const result = await evaluateCombinations(db, { combinationIds: [first.id, second.id], now: new Date("2026-01-01T10:00:00Z") });

    expect(result).toMatchObject({ evaluated: 1, changed: 1, failed: 1 });
    expect(result.pending.map((p) => p.combinationId)).toEqual([first.id]);
    expect((await db.select().from(combinations).where(eq(combinations.id, first.id)))[0].state).toBe("alert");
    // A que falhou foi desfeita (transação) e será tentada de novo no próximo ciclo.
    expect((await db.select().from(combinations).where(eq(combinations.id, second.id)))[0].state).toBe("ok");

    vi.mocked(findTriggeredAutomations).mockImplementation(real);
    const retry = await evaluateCombinations(db, { combinationIds: [second.id], now: new Date("2026-01-01T10:00:30Z") });
    expect(retry).toMatchObject({ changed: 1, failed: 0 });
    expect(retry.pending).toHaveLength(1);
  });
});
