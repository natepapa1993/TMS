import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

// The cloud container ships a pinned Chromium; CI and laptops use Playwright's own.
const shell = "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell";
const port = process.env.E2E_PORT ?? "3123";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // tests share one database; they create their own tenants, but keep it deterministic
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${port}`,
    trace: "retain-on-failure",
    launchOptions: { executablePath: existsSync(shell) ? shell : undefined, args: ["--no-proxy-server"] },
    viewport: { width: 1440, height: 900 },
  },
  webServer: process.env.E2E_BASE_URL ? undefined : { command: `pnpm start -p ${port}`, url: `http://localhost:${port}/api/health`, reuseExistingServer: !process.env.CI, timeout: 120_000 },
});
