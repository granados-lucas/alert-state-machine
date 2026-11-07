import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { auditLog, combinationAutomations, combinationEvaluatorHeartbeat, combinations } from "@/db/schema";
import type { Db } from "@/server/db-types";
import { createTestDb } from "@/test/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

let n = 0;
const combo = (over: Partial<typeof combinations.$inferInsert> = {}) => ({ name: `c${++n}`, rule: "and" as const, ...over });
const rejects = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toThrow();
};

describe("combinations", () => {
  it("aceita uma combinação válida com os padrões", async () => {
    const [row] = await db.insert(combinations).values(combo()).returning();
    expect(row).toMatchObject({ state: "ok", durationSeconds: 0, minCount: null, satisfiedSince: null, archivedAt: null });
  });

  it("at_least exige min_count e as outras regras o proíbem", async () => {
    await rejects(db.insert(combinations).values(combo({ rule: "at_least" })));
    await rejects(db.insert(combinations).values(combo({ rule: "and", minCount: 2 })));
    await rejects(db.insert(combinations).values(combo({ rule: "at_least", minCount: 0 })));
    await db.insert(combinations).values(combo({ rule: "at_least", minCount: 2 }));
  });

  it("limita a duração a 0..86400 s", async () => {
    await rejects(db.insert(combinations).values(combo({ durationSeconds: 86_401 })));
    await rejects(db.insert(combinations).values(combo({ durationSeconds: -1 })));
    await db.insert(combinations).values(combo({ durationSeconds: 86_400 }));
  });

  it("rejeita nome repetido", async () => {
    const name = "repetido";
    await db.insert(combinations).values(combo({ name }));
    await rejects(db.insert(combinations).values(combo({ name })));
  });
});

describe("combination_automations", () => {
  const automation = async (over: Partial<typeof combinationAutomations.$inferInsert> = {}) => {
    const [parent] = await db.insert(combinations).values(combo()).returning({ id: combinations.id });
    return { combinationId: parent.id, name: "a", mode: "webhook" as const, url: "https://hooks.test/x", ...over };
  };

  it("aceita gatilhos alert e ok e rejeita pending", async () => {
    await db.insert(combinationAutomations).values(await automation({ triggerStates: ["alert", "ok"] }));
    await rejects(db.insert(combinationAutomations).values(await automation({ triggerStates: ["pending"] })));
    await rejects(db.insert(combinationAutomations).values(await automation({ triggerStates: ["alert", "pending"] })));
  });

  it("limita o timeout a 100..15000 ms", async () => {
    await rejects(db.insert(combinationAutomations).values(await automation({ timeoutMs: 99 })));
    await rejects(db.insert(combinationAutomations).values(await automation({ timeoutMs: 15_001 })));
  });
});

describe("combination_evaluator_heartbeat", () => {
  it("tem uma única linha (id = 1)", async () => {
    await db.insert(combinationEvaluatorHeartbeat).values({ lastRunAt: new Date() });
    await rejects(db.insert(combinationEvaluatorHeartbeat).values({ id: 2, lastRunAt: new Date() }));
    await rejects(db.insert(combinationEvaluatorHeartbeat).values({ lastRunAt: new Date() }));
  });
});

describe("audit_log", () => {
  it("aceita combination_id e continua imutável", async () => {
    const [parent] = await db.insert(combinations).values(combo()).returning({ id: combinations.id });
    const [row] = await db
      .insert(auditLog)
      .values({ kind: "combination_created", actor: "t", combinationId: parent.id })
      .returning({ id: auditLog.id });
    await rejects(db.execute(sql`update audit_log set actor = 'x' where id = ${row.id}`));
  });
});
