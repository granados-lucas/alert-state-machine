import { afterEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
afterEach(() => vi.unstubAllEnvs());

it("removes structured secrets while keeping useful context", async () => {
  vi.stubEnv("LOG_LEVEL", "info");
  const { createLogger } = await import("./logger");
  const lines: string[] = [];
  const log = createLogger({ write: (line) => { lines.push(line); } });
  log.info({
    token: "test-secret",
    DATABASE_URL: "postgresql://private-test-value",
    DATABASE_URL_UNPOOLED: "postgresql://direct-test-value",
    user: { password: "test-password", id: "user-1" },
    req: { headers: { authorization: "Bearer test-token", cookie: "session=test", "x-api-key": "test-api-key" } },
    requestId: "request-1",
  }, "Request completed");

  const output = lines.join("");
  expect(output).not.toContain("test-secret");
  expect(output).not.toContain("private-test-value");
  expect(output).not.toContain("direct-test-value");
  expect(output).not.toContain("test-api-key");
  expect(output).not.toContain("test-password");
  expect(output).not.toContain("test-token");
  expect(output).not.toContain("session=test");
  expect(JSON.parse(output)).toMatchObject({ requestId: "request-1", user: { id: "user-1" } });
});
