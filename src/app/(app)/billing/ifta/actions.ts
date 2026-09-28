"use server";

import { revalidatePath } from "next/cache";
import { act } from "@/lib/action";

async function csvOf(form: FormData) {
  const f = form.get("file");
  if (!(f instanceof File) || !f.size) throw Object.assign(new Error("Choose the IFTA rate matrix CSV"), { name: "ValidationError", field: "file" });
  if (f.size > 2 * 1024 * 1024) throw Object.assign(new Error("That file is over 2 MB — is it the rate matrix?"), { name: "ValidationError", field: "file" });
  return f.text();
}

/** Owner #21: read the matrix and show what would change; nothing is saved. */
export async function previewRateMatrixAction(quarter: string, form: FormData) {
  const I = await import("@/domain/ifta");
  return act(async (ctx) => I.previewRateMatrix(ctx, quarter, await csvOf(form)));
}

export async function importRateMatrixAction(quarter: string, form: FormData) {
  const I = await import("@/domain/ifta");
  const r = await act(async (ctx) => I.importRateMatrix(ctx, quarter, await csvOf(form)));
  if (r.ok) revalidatePath("/billing/ifta");
  return r;
}
