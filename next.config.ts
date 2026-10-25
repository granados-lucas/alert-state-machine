import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

// Versão do pacote disponível ao servidor (tela /status e métrica build_info).
const { version } = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };

const nextConfig: NextConfig = {
  // Imagem Docker enxuta (server.js autocontido).
  output: "standalone",
  env: { APP_VERSION: version },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
