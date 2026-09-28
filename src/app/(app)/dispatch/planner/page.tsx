import { requireCtx } from "@/lib/auth";
import { plannerData } from "@/domain/planner";
import { Planner } from "./planner";
import { canSeeMoney } from "@/domain/money-visibility";

export const metadata = { title: "Planner" };
export const dynamic = "force-dynamic";

export default async function PlannerPage() {
  const ctx = await requireCtx();
  const [raw, showMoney] = await Promise.all([plannerData(ctx), canSeeMoney(ctx)]);
  // money hidden from dispatchers: the rate doesn't leave the server either
  const data = showMoney ? raw : { ...raw, legs: raw.legs.map((l) => ({ ...l, rateCents: null })) };
  return <Planner data={JSON.parse(JSON.stringify(data))} canPlan={["owner", "dispatcher"].includes(ctx.role)} />;
}
