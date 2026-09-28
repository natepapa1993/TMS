import { redirect } from "next/navigation";
import { currentCtx } from "@/lib/auth";
import { homeFor } from "@/lib/home";

/** "/" is each role's own home page. */
export default async function Home() {
  const ctx = await currentCtx();
  redirect(ctx ? homeFor(ctx.role) : "/login");
}
