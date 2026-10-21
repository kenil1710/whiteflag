import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs/,
  timeout: 90 * 60 * 1000,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "../../docs/e2e/results.json" }]],
  use: {
    baseURL: process.env.E2E_BASE ?? "https://whiteflag-ledger.vercel.app",
    viewport: { width: 1280, height: 900 },
    actionTimeout: 60_000,
    navigationTimeout: 120_000,
  },
});
