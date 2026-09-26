import "./load-env";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";

async function main() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  const client = postgres(url, { max: 1 });
  await client`drop schema public cascade`;
  await client`drop schema if exists drizzle cascade`;
  await client`create schema public`;
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  await client.end();
  console.log("test database reset");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
