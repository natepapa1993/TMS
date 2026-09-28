/**
 * Builds (or rebuilds) the demo company "Frontera Freight (demo)" in the database DATABASE_URL points
 * at, the same way the deployment does at startup with DEMO_COMPANY=1. Needs DEMO_PASSWORD.
 * Usage: tsx scripts/demo-company.ts [build|rebuild|remove]
 */
import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const cmd = process.argv[2] ?? "build";
  const D = await import("@/db/demo-company");
  const r = cmd === "remove" ? await D.removeDemoCompany() : await D.ensureDemoCompany({ force: cmd === "rebuild" });
  console.log(r);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
