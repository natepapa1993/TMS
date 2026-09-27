import { readFileSync, existsSync } from "node:fs";

/**
 * Feature board gate (spec §10.1a): a feature can only be "done" when every test file it names
 * exists and mentions the feature ID (so the test is actually about it). Prints the board.
 */
type Feature = { id: string; name: string; milestone: string; status: "done" | "in_progress" | "planned"; tests: string[] };
const board = JSON.parse(readFileSync("docs/features.json", "utf8")) as { features: Feature[] };
let bad = 0;
const rows: string[] = [];
for (const f of board.features) {
  const problems: string[] = [];
  if (f.status === "done") {
    if (!f.tests.length) problems.push("no tests");
    for (const t of f.tests) {
      if (!existsSync(t)) problems.push(`${t} missing`);
      else if (!new RegExp(`\\b${f.id.replace(".", "\\.")}\\b`).test(readFileSync(t, "utf8"))) problems.push(`${t} never mentions ${f.id}`);
    }
  }
  if (problems.length) bad++;
  rows.push(`${problems.length ? "✗" : f.status === "done" ? "✓" : "·"} ${f.id.padEnd(8)} ${f.milestone.padEnd(3)} ${f.status.padEnd(11)} ${f.name}${problems.length ? `\n      ${problems.join("; ")}` : ""}`);
}
console.log(rows.join("\n"));
const done = board.features.filter((f) => f.status === "done").length;
console.log(`\n${done}/${board.features.length} features done, ${bad} problem(s)`);
if (bad) process.exit(1);
