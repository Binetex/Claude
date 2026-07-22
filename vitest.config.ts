import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      "server-only": path.resolve(__dirname, "./vitest.server-only-stub.ts"),
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
