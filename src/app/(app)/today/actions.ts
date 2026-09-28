"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/lib/action";
import * as A from "@/domain/approvals";

const touch = () => {
  revalidatePath("/today");
  revalidatePath("/dispatch");
  revalidatePath("/compliance/overrides");
};

export async function approveOverrideAction(id: string, note?: string) {
  const r = await act((ctx) => A.approveOverride(ctx, id, note));
  if (r.ok) touch();
  return r;
}

export async function rejectOverrideAction(id: string, note: string) {
  const r = await act((ctx) => A.rejectOverride(ctx, id, note));
  if (r.ok) touch();
  return r;
}

export async function overrideApprovalSettingAction(on: boolean) {
  const r = await act((ctx) => A.setOverrideApproval(ctx, on));
  if (r.ok) {
    touch();
    revalidatePath("/settings/company");
  }
  return r;
}
