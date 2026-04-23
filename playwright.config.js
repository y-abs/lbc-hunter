import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false, // extension state is shared across tabs
  workers: 1, // one browser at a time (one user profile)
  retries: 0,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    video: "off",
  },
});
