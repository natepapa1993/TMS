import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
    fileParallelism: false,
    coverage: { provider: "v8", reporter: ["text", "lcov"], include: ["src/**/*.ts"], exclude: ["src/**/*.test.ts", "src/test/**"] },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
