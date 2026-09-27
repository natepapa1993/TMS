"use server";

import { toError, type ActionResult } from "@/lib/action";
import { respondToTender, type TenderResponse } from "@/domain/tenders";
import { resolveToken } from "@/lib/tokens";
import { driverStep, recordPosition, type DriverStepInput } from "@/domain/tracking";

/** Public server functions: the token in the URL is the only authorization, and it is checked here every time. */

export async function respondTenderAction(token: string, r: TenderResponse): Promise<ActionResult<{ state: "accepted" | "declined" }>> {
  try {
    const res = await respondToTender(token, r);
    return { ok: true, data: { state: res.state } };
  } catch (e) {
    return toError(e);
  }
}

export async function driverStepAction(token: string, legId: string, input: DriverStepInput): Promise<ActionResult<{ state: string }>> {
  const t = await resolveToken(token, "driver_app");
  if (!t) return { ok: false, error: "This link is no longer valid. Ask dispatch for a new one.", code: "not_found" };
  try {
    const leg = await driverStep(t.ctx.tenantId, t.subjectId, legId, input);
    return { ok: true, data: { state: leg.state } };
  } catch (e) {
    return toError(e);
  }
}

/** Background ping from the driver's phone while the app is open. */
export async function driverPingAction(token: string, p: { lat: number; lng: number; accuracyM?: number | null; speedMph?: number | null; heading?: number | null }): Promise<ActionResult<{ ok: true }>> {
  const t = await resolveToken(token, "driver_app");
  if (!t) return { ok: false, error: "invalid link", code: "not_found" };
  try {
    const { db } = await import("@/db/client");
    const { drivers } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const [d] = await db.select({ currentTruckId: drivers.currentTruckId }).from(drivers).where(eq(drivers.id, t.subjectId)).limit(1);
    await recordPosition(t.ctx, { source: "phone", lat: p.lat, lng: p.lng, accuracyM: p.accuracyM ?? null, speedMph: p.speedMph ?? null, heading: p.heading ?? null, driverId: t.subjectId, truckId: d?.currentTruckId ?? null });
    return { ok: true, data: { ok: true } };
  } catch (e) {
    return toError(e);
  }
}
