import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Imagem Docker enxuta (server.js autocontido).
  output: "standalone",
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
