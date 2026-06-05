import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    globals: true,
    environment: "node",
    // Fork: neutralize a developer's personal CLAUDE_CODE_THINKING_DISPLAY (read
    // by createSession) so it can't leak into tests; individual tests set it
    // explicitly when exercising the thinking-display behavior.
    env: { CLAUDE_CODE_THINKING_DISPLAY: "" },
    include: ["src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
