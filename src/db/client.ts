import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.NODE_ENV === "test" ? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL : process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

declare global {
  var __tmsSql: ReturnType<typeof postgres> | undefined;
}

// One connection pool per process (Next.js hot reload re-evaluates modules).
export const sqlClient = globalThis.__tmsSql ?? postgres(url, { max: 10, prepare: false });
if (process.env.NODE_ENV !== "production") globalThis.__tmsSql = sqlClient;

export const db = drizzle(sqlClient, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
