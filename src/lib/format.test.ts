import { expect, it } from "vitest";
import { formatTime } from "./format";

it("formata em UTC e tolera valores ausentes ou inválidos", () => {
  expect(formatTime(new Date("2026-01-02T03:04:05.678Z"))).toBe("2026-01-02 03:04:05 UTC");
  expect(formatTime("2026-01-02T03:04:05Z")).toBe("2026-01-02 03:04:05 UTC");
  expect(formatTime(null)).toBe("—");
  expect(formatTime("lixo")).toBe("—");
});
