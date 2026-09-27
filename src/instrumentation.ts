/**
 * Runs once when the Next.js server starts (Node runtime only). With MIGRATE_ON_START=1 the
 * deployment migrates its own database and seeds the demo company if it is missing, and the
 * output lands in the deploy log where an operator can see it.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.MIGRATE_ON_START !== "1") return;
  const { runMigrations } = await import("./db/migrate-lib");
  await runMigrations();
  console.log("startup: migrations applied");
  if (process.env.SEED_ON_START === "1") {
    const { seedDemo } = await import("./db/seed-lib");
    console.log(`startup: seed ${await seedDemo()}`);
  }
}
