/**
 * Runs once when the Next.js server starts (Node runtime only). With MIGRATE_ON_START=1 the
 * deployment migrates its own database, and the output lands in the deploy log where an operator
 * can see it. Nothing is seeded: the owner adds his own customers, carriers, locations and equipment.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.MIGRATE_ON_START === "1") {
    const { runMigrations } = await import("./db/migrate-lib");
    await runMigrations();
    console.log("startup: migrations applied");
    // the app starts empty: no demo company is ever seeded in a deployment; one that was is cleared once
    const { clearSeededDemo } = await import("./db/clear-seed");
    console.log(`startup: seed cleanup — ${await clearSeededDemo().catch((e) => `failed: ${String(e)}`)}`);
  }
  if (process.env.JOBS_ON_START === "1") {
    const { startTicker } = await import("./jobs/tick");
    startTicker(Number(process.env.JOBS_EVERY_MS ?? 60_000));
  }
}
