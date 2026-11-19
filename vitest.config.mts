import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirrors tsconfig `"@/*": ["./*"]`.
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // Next resolves `server-only` to an empty module on the server (react-server
      // condition) and fails the build if a client module imports it. Tests run
      // as server code, so use the same empty module.
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
