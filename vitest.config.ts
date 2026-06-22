import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { TEST_DATABASE_URL, TEST_REDIS_URL, TEST_SERVICE_TOKEN } from "./test/constants";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@\//,
        replacement: fileURLToPath(new URL("./src/", import.meta.url)),
      },
    ],
    extensionAlias: {
      ".js": [".ts", ".js"],
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // The DB-backed tests share one test database and isolate by truncating
    // between cases (see test/helpers/db.ts). Within a file vitest runs cases
    // serially, but files run in parallel by default, which would let two
    // DB-backed files truncate and write the same database concurrently. Run
    // files serially so the shared database stays consistent.
    fileParallelism: false,
    // Ensures the test database exists and applies the migrations once before the
    // suite. DB-backed tests then truncate between cases for isolation.
    globalSetup: ["./test/global-setup.ts"],
    env: {
      NODE_ENV: "test",
      // The shell or CI may override the connection (the global setup and the
      // workers both read these); the fallbacks point at docker-compose.dev.
      DATABASE_URL: process.env.DATABASE_URL ?? TEST_DATABASE_URL,
      REDIS_URL: process.env.REDIS_URL ?? TEST_REDIS_URL,
      SERVICE_TOKEN: TEST_SERVICE_TOKEN,
    },
  },
});
