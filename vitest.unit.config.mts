import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  test: {
    environment: "node",
    include: [
      "src/server/db/*.unit.test.ts",
      "src/server/collections/engine.notifications.test.ts",
      "src/server/communications/*.unit.test.ts",
      "src/app/api/webhooks/delivery/[[]provider]/route.test.ts",
      "src/server/communications/channel.test.ts",
      "src/server/communications/reminder-origin.test.ts",
    ],
    env: { NODE_ENV: "test" },
  },
});
