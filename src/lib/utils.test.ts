import { expect, it } from "vitest";
import { cn } from "./utils";

it("cn mescla classes e resolve conflitos do Tailwind", () => {
  expect(cn("px-2", false && "hidden", "px-4")).toBe("px-4");
});
