import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
    // PGlite (WASM) inicia em ~1 s por arquivo de teste.
    testTimeout: 20_000,
    // Cada arquivo com PGlite carrega um PostgreSQL em WASM (centenas de MB): em paralelo total o
    // processo de teste abortou algumas vezes no Windows (exit 0x80000003, provável falta de memória); com 2 workers ficou estável.
    maxWorkers: 2,
    coverage: {
      provider: "v8",
      // Cobertura da lógica em .ts (domínio, provedores, serviços, rotas). Telas .tsx não entram:
      // são verificadas por build, tipos e pelo smoke test com docker (docs/quality.md).
      include: ["src/**/*.ts"],
      // O esquema é declarativo (exercitado pelas migrações reais nos testes); meta.ts são constantes de UI.
      exclude: ["src/**/*.test.ts", "src/test/**", "src/db/schema/**", "src/components/**/meta.ts"],
      reporter: ["text-summary", "text", "html"],
      thresholds: { statements: 90, lines: 90, functions: 90, branches: 80 },
    },
  },
});
