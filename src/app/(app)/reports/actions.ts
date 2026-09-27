"use server";

import { act } from "@/lib/action";
import { orderDetail, type Period } from "@/domain/reports";

export async function orderDetailAction(period: Period, entityId: string | null, orderIds: string[]) {
  return act((ctx) => orderDetail(ctx, period, entityId, orderIds));
}
