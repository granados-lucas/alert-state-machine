import { afterEach, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { closeDatabase, getDb } from "./index";
import { logger } from "@/lib/logger";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("pg", () => ({
  Pool: vi.fn(function () {
    return { on: vi.fn(), end: vi.fn().mockResolvedValue(undefined) };
  }),
}));

afterEach(async () => {
  await closeDatabase();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("rejects missing configuration before creating a pool", () => {
  vi.stubEnv("DATABASE_URL", undefined);
  expect(() => getDb()).toThrow("DATABASE_URL");
  expect(Pool).not.toHaveBeenCalled();
});

it("reuses one bounded pool and replaces it after explicit shutdown", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://app:development@localhost:5432/app");
  const first = getDb();
  expect(getDb()).toBe(first);
  expect(Pool).toHaveBeenCalledTimes(1);
  expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ max: 5, connectionTimeoutMillis: 5_000 }));
  const pool = vi.mocked(Pool).mock.results[0]?.value;
  expect(pool).toBeDefined();
  await closeDatabase();
  expect(pool.end).toHaveBeenCalledOnce();
  expect(getDb()).not.toBe(first);
  expect(Pool).toHaveBeenCalledTimes(2);
});

it("handles idle errors without logging the raw error or connection string", () => {
  vi.stubEnv("DATABASE_URL", "postgresql://app:development@localhost:5432/app");
  getDb();
  const pool = vi.mocked(Pool).mock.results[0]?.value;
  const calls = vi.mocked(pool.on).mock.calls as [string, (error: Error) => void][];
  const handler = calls.find(([event]) => event === "error")?.[1];
  expect(handler).toBeTypeOf("function");
  handler?.(Object.assign(new Error("sensitive-test-value"), { code: "ECONNRESET" }));
  expect(logger.error).toHaveBeenCalledWith({ code: "ECONNRESET" }, "Idle database connection failed");
  expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("sensitive-test-value");
});
