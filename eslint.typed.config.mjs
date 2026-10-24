// Focused async-safety gate for new Next projects; run separately with lint:typed.
import defaultConfig from "./eslint.config.mjs";

const config = [
  ...defaultConfig,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Preserve existing severity; only new rules with violations may start as warnings.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
];

export default config;
