import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/db/**/*.test.ts"],
    // DB テストは PGlite（WASM）を起動するので時間がかかる
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
