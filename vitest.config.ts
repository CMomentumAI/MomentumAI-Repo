import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    // setupFiles run once before ALL test files — use it to populate env vars.
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/test/**/*.test.ts"],
    // Print a clean summary; individual failures already show line numbers.
    reporters: ["verbose"],
  },
  resolve: {
    // Mirror the @/ alias from tsconfig.json so test imports match app imports.
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
