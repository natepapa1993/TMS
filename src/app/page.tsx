import { redirect } from "next/navigation";
import { currentCtx } from "@/lib/auth";

export default async function Home() {
  const ctx = await currentCtx();
  redirect(ctx ? "/dispatch" : "/login");
}
