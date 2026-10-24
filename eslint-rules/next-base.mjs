// Shared official Next/TypeScript baseline for both toolkit profiles.
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import quality from "./index.cjs";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["eslint-rules/**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["**/*.{js,jsx,ts,tsx,mjs,cjs}"],
    plugins: { quality },
    rules: {
      "quality/max-lines": ["error", { max: 350 }],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    "graphify-out/**",
  ]),
]);
