import { requireCtx } from "@/lib/auth";
import { plannerData } from "@/domain/planner";
import { Planner } from "./planner";

export const metadata = { title: "Planner" };
export const dynamic = "force-dynamic";

export default async function PlannerPage() {
  const ctx = await requireCtx();
  const data = await plannerData(ctx);
  return <Planner data={JSON.parse(JSON.stringify(data))} canPlan={["owner", "dispatcher"].includes(ctx.role)} />;
}
