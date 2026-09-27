"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { act } from "@/lib/action";
import * as O from "@/domain/orders";
import type { StopType } from "@/db/schema";
import { parseDate, parseAddress } from "@/data/fields";
import { stopTimeProblems } from "@/domain/zones";
import type { StopPayload } from "@/components/stop-fields";

const touch = (id?: string) => {
  revalidatePath("/dispatch");
  revalidatePath("/orders");
  if (id) revalidatePath(`/orders/${id}`);
};

export type StopForm = { type: StopType; name: string; address: string; country: string; windowStart: string; windowEnd: string; appointment: boolean; contact: string; notes: string; sealIn?: string; sealOut?: string };


/** A stop from the builder: a saved location or typed in; "save as a location" creates the location first. */
async function stopFromPayload(ctx: Parameters<Parameters<typeof act>[0]>[0], st: StopPayload): Promise<O.StopInput> {
  const address = st.line1 || st.city || st.state || st.postalCode ? { line1: st.line1 || undefined, city: st.city || undefined, state: st.state ? st.state.toUpperCase() : undefined, postalCode: st.postalCode || undefined, country: st.country } : null;
  let locationId = st.locationId || null;
  if (!locationId && st.saveLocation && st.name) {
    if (!address?.line1 && !address?.city) throw Object.assign(new Error(`add an address to save "${st.name}" as a location`), { name: "ValidationError", field: "stops" });
    const { create } = await import("@/data/records");
    const kind = ({ pickup: "shipper", delivery: "consignee" } as Record<string, string>)[st.type] ?? st.type;
    const loc = await create(ctx, "location", { name: st.name, kind, country: st.country, address });
    locationId = loc.id;
  }
  return {
    type: st.type as StopType,
    name: st.name,
    locationId,
    address,
    country: st.country || "US",
    windowStart: st.windowStart ? new Date(st.windowStart) : null,
    windowEnd: st.windowEnd ? new Date(st.windowEnd) : null,
    appointment: !!st.appointment,
    contact: st.contact || null,
    refs: st.ref ? { reference: st.ref } : {},
    notes: st.notes || null,
  };
}

export type LoadInput = { customerId: string; brokerId: string; billingEntityId: string; equipment: string; rate: string; rateTbd: boolean; currency: string; refs: Record<string, string>; cargoNote: string; freight: { commodity: string; pieces: string; packaging: string; weightLb: string; hazmat: boolean }[]; stops: StopPayload[]; book: boolean; rateConDocId?: string | null; contract?: { rateId: string; rateType: string; unitCents: number; miles: number | null; fuelRule: string; fuelPct: number | null; fuelCentsPerMile: number | null } | null };

/** Read an uploaded rate con into a draft for the builder (AI reader). */
export async function readRateConAction(form: FormData) {
  const f = form.get("file");
  if (!(f instanceof File)) return { ok: false as const, error: "Choose the rate con file" };
  const { readRateConForBuilder } = await import("@/domain/ratecon-reader");
  const bytes = Buffer.from(await f.arrayBuffer());
  return act((ctx) => readRateConForBuilder(ctx, { fileName: f.name, mimeType: f.type || "application/pdf", bytes }));
}

/** The customer's contract rate for the lane being built (first pickup → last delivery), with estimated miles. */
export async function suggestRateAction(input: { customerId: string; equipment: string; stops: { locationId: string | null; name: string; city: string; state: string; windowStart?: string }[] }) {
  return act(async (ctx) => {
    if (!input.customerId || input.stops.length < 2) return null;
    const { suggestCustomerRate, routeMiles } = await import("@/domain/rates");
    const from = input.stops[0];
    const to = input.stops[input.stops.length - 1];
    if (!from.name.trim() || !to.name.trim()) return null;
    const miles = await routeMiles(ctx, input.stops.map((x) => x.locationId));
    const date = from.windowStart ? from.windowStart.slice(0, 10) : null;
    return suggestCustomerRate(ctx, { customerId: input.customerId, equipment: input.equipment, from: { name: from.name, address: { city: from.city, state: from.state } }, to: { name: to.name, address: { city: to.city, state: to.state } }, miles, date });
  });
}

/** The load builder: any number of stops; the legs are cut from them. */
export async function createLoadAction(input: LoadInput) {
  const r = await act(async (ctx) => {
    const rateCents = input.rate.trim() ? Math.round(Number(input.rate.replace(/[$,\s]/g, "")) * 100) : null;
    if (input.rate.trim() && !Number.isFinite(rateCents)) throw Object.assign(new Error("Rate must be a number"), { name: "ValidationError", field: "rate" });
    if (input.stops.length < 2) throw Object.assign(new Error("a load needs at least a pickup and a delivery"), { name: "ValidationError", field: "stops" });
    if (!input.stops.some((s) => s.type === "pickup")) throw Object.assign(new Error("add the pickup"), { name: "ValidationError", field: "stops" });
    if (!input.stops.some((s) => s.type === "delivery")) throw Object.assign(new Error("add the delivery"), { name: "ValidationError", field: "stops" });
    const refs: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.refs)) if (v?.trim()) refs[k] = v.trim();
    const freight = input.freight
      .filter((l) => l.commodity.trim() || l.pieces.trim() || l.weightLb.trim())
      .map((l) => ({ commodity: l.commodity.trim() || "freight", pieces: l.pieces.trim() ? Number(l.pieces) : undefined, packaging: l.packaging.trim() || undefined, weightLb: l.weightLb.trim() ? Number(l.weightLb.replace(/[,\s]/g, "")) : undefined, hazmat: l.hazmat || undefined }));
    for (const l of freight) if ((l.pieces != null && !Number.isFinite(l.pieces)) || (l.weightLb != null && !Number.isFinite(l.weightLb))) throw Object.assign(new Error("pieces and weight are numbers"), { name: "ValidationError", field: "freight" });
    const stops = [];
    const timing = stopTimeProblems(input.stops.map((st) => ({ windowStart: st.windowStart || null, windowEnd: st.windowEnd || null, name: st.name })));
    if (timing.length) throw Object.assign(new Error(`Check the stop times: ${timing.join("; ")}`), { name: "ValidationError", field: "stops" });
    for (const st of input.stops) stops.push(await stopFromPayload(ctx, st));
    const created = await O.createOrder(ctx, {
      customerId: input.customerId || null,
      brokerId: input.brokerId || null,
      billingEntityId: input.billingEntityId || null,
      equipment: input.equipment || "53_dry",
      rateCents,
      rateTbd: input.rateTbd || rateCents == null,
      currency: input.currency || "USD",
      refs,
      freight,
      cargoNote: input.cargoNote || null,
      stops,
      book: input.book,
      ...(input.contract
        ? {
            customerRateId: input.contract.rateId,
            rateType: input.contract.rateType === "per_mile" ? "per_mile" : "flat",
            rateUnitCents: input.contract.rateType === "per_mile" ? input.contract.unitCents : null,
            rateQty: input.contract.rateType === "per_mile" ? input.contract.miles : null,
            fuelRule: input.contract.fuelRule,
            fuelPct: input.contract.fuelPct,
            fuelCentsPerMile: input.contract.fuelCentsPerMile,
          }
        : {}),
    });
    if (input.rateConDocId) {
      const { attachDraftRateCon } = await import("@/domain/ratecon-reader");
      await attachDraftRateCon(ctx, input.rateConDocId, created.order.id);
    }
    return created;
  });
  if (r.ok) {
    touch();
    redirect(`/dispatch?order=${r.data.order.id}`);
  }
  return r;
}

export async function addStopAction(orderId: string, position: number, stop: StopPayload) {
  const r = await act(async (ctx) => {
    if (!stop.name) throw Object.assign(new Error("the stop needs a location name"), { name: "ValidationError", field: "name" });
    const input = await stopFromPayload(ctx, stop);
    await O.addStop(ctx, orderId, position, input);
    return { ok: true };
  });
  if (r.ok) touch(orderId);
  return r;
}

export async function removeStopAction(orderId: string, stopId: string) {
  const r = await act(async (ctx) => {
    await O.removeStop(ctx, orderId, stopId);
    return { ok: true };
  });
  if (r.ok) touch(orderId);
  return r;
}

export async function moveStopAction(orderId: string, stopId: string, dir: -1 | 1) {
  const r = await act(async (ctx) => {
    await O.moveStop(ctx, orderId, stopId, dir);
    return { ok: true };
  });
  if (r.ok) touch(orderId);
  return r;
}

export async function updateOrderAction(orderId: string, values: { customerId?: string; brokerId?: string; billingEntityId?: string; equipment?: string; rate?: string; rateTbd?: boolean; currency?: string; refs?: Record<string, string>; cargoNote?: string; fuelRule?: string; fuelPct?: string; fuelCpm?: string; tollsFees?: string; rateType?: string; rateUnit?: string; rateQty?: string; priority?: string; salesAgentId?: string; csrId?: string; dispatcherId?: string }, expectedUpdatedAt?: string) {
  const r = await act(async (ctx) => {
    const patch: Record<string, unknown> = {};
    if (values.priority !== undefined) patch.priority = values.priority || "none";
    for (const k of ["salesAgentId", "csrId", "dispatcherId"] as const) if (values[k] !== undefined) patch[k] = values[k] || null;
    if (values.rateType !== undefined) patch.rateType = values.rateType || "flat";
    if (values.rateUnit !== undefined) {
      const c = values.rateUnit.trim() ? Math.round(Number(values.rateUnit.replace(/[$,\s]/g, "")) * 100) : null;
      if (values.rateUnit.trim() && !Number.isFinite(c)) throw Object.assign(new Error("Unit rate must be an amount"), { name: "ValidationError", field: "rateUnit" });
      patch.rateUnitCents = c;
    }
    if (values.rateQty !== undefined) {
      const q = values.rateQty.trim() ? Number(values.rateQty.replace(/[,\s]/g, "")) : null;
      if (values.rateQty.trim() && !Number.isFinite(q)) throw Object.assign(new Error("Quantity must be a number"), { name: "ValidationError", field: "rateQty" });
      patch.rateQty = q == null ? null : Math.round(q);
    }
    if (values.customerId !== undefined) patch.customerId = values.customerId || null;
    if (values.brokerId !== undefined) patch.brokerId = values.brokerId || null;
    if (values.billingEntityId !== undefined) patch.billingEntityId = values.billingEntityId || null;
    if (values.equipment !== undefined) patch.equipment = values.equipment;
    if (values.currency !== undefined) patch.currency = values.currency;
    if (values.cargoNote !== undefined) patch.cargoNote = values.cargoNote || null;
    if (values.fuelRule !== undefined) patch.fuelRule = values.fuelRule === "pct" || values.fuelRule === "per_mile" ? values.fuelRule : "included";
    if (values.fuelCpm !== undefined) {
      const n = values.fuelCpm.trim() ? Number(values.fuelCpm.replace(/[¢\s]/g, "")) : null;
      if (n != null && (!Number.isFinite(n) || n < 0 || n > 500)) throw Object.assign(new Error("Fuel ¢/mile must be 0–500"), { name: "ValidationError", field: "fuelCpm" });
      patch.fuelCentsPerMile = n == null ? null : Math.round(n);
      if (patch.fuelRule === "per_mile" && patch.fuelCentsPerMile == null) throw Object.assign(new Error("Enter the fuel surcharge in cents per mile"), { name: "ValidationError", field: "fuelCpm" });
    }
    if (values.fuelPct !== undefined) {
      const n = values.fuelPct.trim() ? Number(values.fuelPct.replace("%", "")) : null;
      if (n != null && (!Number.isFinite(n) || n < 0 || n > 100)) throw Object.assign(new Error("Fuel % must be 0–100"), { name: "ValidationError", field: "fuelPct" });
      patch.fuelPct = n == null ? null : Math.round(n);
      if (patch.fuelRule === "pct" && patch.fuelPct == null) throw Object.assign(new Error("Enter the fuel surcharge percent"), { name: "ValidationError", field: "fuelPct" });
    }
    if (values.tollsFees !== undefined) {
      const c = values.tollsFees.trim() ? Math.round(Number(values.tollsFees.replace(/[$,\s]/g, "")) * 100) : null;
      if (values.tollsFees.trim() && !Number.isFinite(c)) throw Object.assign(new Error("Tolls & fees must be an amount"), { name: "ValidationError", field: "tollsFees" });
      patch.tollsFeesCents = c;
    }
    if (values.rate !== undefined && (values.rateType ?? "flat") === "flat") {
      const c = values.rate.trim() ? Math.round(Number(values.rate.replace(/[$,\s]/g, "")) * 100) : null;
      if (values.rate.trim() && !Number.isFinite(c)) throw Object.assign(new Error("Rate must be a number"), { name: "ValidationError", field: "rate" });
      patch.rateCents = c;
      patch.rateTbd = c == null ? true : !!values.rateTbd;
    }
    if (values.refs) {
      const refs: Record<string, string> = {};
      for (const [k, v] of Object.entries(values.refs)) if (v?.trim()) refs[k.trim()] = v.trim();
      patch.refs = refs;
    }
    return O.updateOrder(ctx, orderId, patch, expectedUpdatedAt ? new Date(expectedUpdatedAt) : undefined);
  });
  if (r.ok) touch(orderId);
  return r;
}

export async function updateStopAction(orderId: string, stopId: string, st: Partial<StopForm>) {
  const r = await act(async (ctx) => {
    const patch: Record<string, unknown> = {};
    if (st.name !== undefined) patch.name = st.name;
    if (st.type !== undefined) patch.type = st.type;
    if (st.country !== undefined) patch.country = st.country;
    if (st.address !== undefined) patch.address = st.address.trim() ? parseAddress(st.address) : null;
    // an ISO instant from the form keeps its time; a bare date means noon UTC (a day with no appointment time)
    const instant = (v: string) => (/\dT\d/.test(v) ? new Date(v) : parseDate(v));
    for (const k of ["windowStart", "windowEnd"] as const)
      if (st[k] !== undefined) {
        const d = st[k] ? instant(st[k]!) : null;
        if (st[k] && (!d || Number.isNaN(d.getTime()))) throw Object.assign(new Error("That time could not be read"), { name: "ValidationError", field: k });
        patch[k] = d;
      }
    if (st.appointment !== undefined) patch.appointment = st.appointment;
    if (st.contact !== undefined) patch.contact = st.contact || null;
    if (st.notes !== undefined) patch.notes = st.notes || null;
    if (st.sealIn !== undefined) patch.sealIn = st.sealIn || null;
    if (st.sealOut !== undefined) patch.sealOut = st.sealOut || null;
    return O.updateStop(ctx, stopId, patch);
  });
  if (r.ok) touch(orderId);
  return r;
}

// ---------- load board ----------

export async function saveLoadViewAction(v: { id?: string | null; name: string; shared: boolean; config: import("@/domain/load-grid").ViewConfig }) {
  const { saveView } = await import("@/domain/load-grid");
  const r = await act((ctx) => saveView(ctx, "loads", v));
  if (r.ok) revalidatePath("/orders");
  return r.ok ? { ok: true as const, id: r.data.id } : { ok: false as const, error: r.error };
}

export async function deleteLoadViewAction(id: string) {
  const { deleteView } = await import("@/domain/load-grid");
  const r = await act((ctx) => deleteView(ctx, id));
  if (r.ok) revalidatePath("/orders");
  return r.ok ? { ok: true as const } : { ok: false as const, error: r.error };
}

/** Book every draft in the selection; says which could not be booked and why. */
export async function bulkBookAction(orderIds: string[]) {
  const r = await act(async (ctx) => {
    const failed: string[] = [];
    let booked = 0;
    for (const id of orderIds.slice(0, 500)) {
      try {
        await O.bookOrder(ctx, id);
        booked++;
      } catch (e) {
        failed.push(e instanceof Error ? e.message : String(e));
      }
    }
    return { booked, failed };
  });
  if (r.ok) touch();
  return r;
}

// ---------- lock, TONU, notes ----------

export async function lockAction(orderId: string, locked: boolean) {
  const r = await act((ctx) => O.lockOrder(ctx, orderId, locked));
  if (r.ok) touch(orderId);
  return r;
}

export async function tonuAction(orderId: string, amount: string, reason: string) {
  const r = await act(async (ctx) => {
    const cents = Math.round(Number(String(amount).replace(/[$,\s]/g, "")) * 100);
    return O.markTonu(ctx, orderId, { amountCents: cents, reason });
  });
  if (r.ok) {
    touch(orderId);
    revalidatePath("/billing");
  }
  return r;
}

export async function addNoteAction(orderId: string, kind: string, body: string, pinned: boolean) {
  const { addNote } = await import("@/domain/notes");
  const r = await act((ctx) => addNote(ctx, orderId, { kind, body, pinned }));
  if (r.ok) touch(orderId);
  return r;
}

export async function pinNoteAction(orderId: string, id: string, pinned: boolean) {
  const { pinNote } = await import("@/domain/notes");
  const r = await act((ctx) => pinNote(ctx, id, pinned));
  if (r.ok) touch(orderId);
  return r;
}

export async function deleteNoteAction(orderId: string, id: string) {
  const { deleteNote } = await import("@/domain/notes");
  const r = await act((ctx) => deleteNote(ctx, id));
  if (r.ok) touch(orderId);
  return r;
}

// ---------- load templates ----------

export async function templateDraftAction(templateId: string, date: string) {
  const { templateDraft } = await import("@/domain/load-templates");
  return act((ctx) => templateDraft(ctx, templateId, date));
}

/** Save what is in the builder as a template (times read back as local times at each stop). */
export async function saveBuilderTemplateAction(name: string, input: Omit<LoadInput, "book" | "rateConDocId">) {
  const { templateFromDraft } = await import("@/domain/load-templates");
  const r = await act(async (ctx) => {
    const rateCents = input.rate.trim() && !input.rateTbd ? Math.round(Number(input.rate.replace(/[$,\s]/g, "")) * 100) : null;
    const stops = input.stops.map((st) => ({
      type: st.type as StopType,
      locationId: st.locationId || null,
      name: st.name,
      address: st.line1 || st.city || st.state || st.postalCode ? { line1: st.line1 || undefined, city: st.city || undefined, state: st.state || undefined, postalCode: st.postalCode || undefined } : null,
      country: st.country,
      windowStart: st.windowStart ? new Date(st.windowStart) : null,
      windowEnd: st.windowEnd ? new Date(st.windowEnd) : null,
      appointment: !!st.appointment,
      ref: st.ref || undefined,
      contact: st.contact || null,
      notes: st.notes || null,
    }));
    const freight = input.freight.filter((l) => l.commodity.trim()).map((l) => ({ commodity: l.commodity.trim(), pieces: l.pieces ? Number(l.pieces) : undefined, packaging: l.packaging || undefined, weightLb: l.weightLb ? Number(l.weightLb) : undefined, hazmat: l.hazmat || undefined }));
    return templateFromDraft(ctx, name, { customerId: input.customerId || null, brokerId: input.brokerId || null, billingEntityId: input.billingEntityId || null, equipment: input.equipment, rateCents: Number.isFinite(rateCents) ? rateCents : null, currency: input.currency, refs: {}, freight, cargoNote: input.cargoNote || null, stops });
  });
  if (r.ok) revalidatePath("/orders/templates");
  return r;
}

export async function templateFromOrderAction(orderId: string, name: string) {
  const { templateFromOrder } = await import("@/domain/load-templates");
  const r = await act((ctx) => templateFromOrder(ctx, orderId, name));
  if (r.ok) revalidatePath("/orders/templates");
  return r;
}

export async function loadsFromTemplateAction(templateId: string, dates: string[], book: boolean) {
  const { loadsFromTemplate } = await import("@/domain/load-templates");
  const r = await act((ctx) => loadsFromTemplate(ctx, templateId, dates, { book }));
  if (r.ok) {
    touch();
    revalidatePath("/orders/templates");
  }
  return r;
}

export async function deleteTemplateAction(id: string) {
  const { deleteTemplate } = await import("@/domain/load-templates");
  const r = await act((ctx) => deleteTemplate(ctx, id));
  if (r.ok) revalidatePath("/orders/templates");
  return r;
}

// ---------- import loads from a sheet ----------

async function tableFrom(form: FormData) {
  const f = form.get("file");
  if (!(f instanceof File)) throw Object.assign(new Error("Choose the file"), { name: "ValidationError", field: "file" });
  const { readTable } = await import("@/domain/load-import");
  return { table: await readTable({ fileName: f.name, bytes: Buffer.from(await f.arrayBuffer()) }), fileName: f.name };
}

export async function previewLoadsAction(form: FormData) {
  const { previewLoads } = await import("@/domain/load-import");
  return act(async (ctx) => {
    const { table } = await tableFrom(form);
    const p = await previewLoads(ctx, table);
    return {
      layout: p.layout,
      loads: p.loads.map((l) => ({ key: l.key, customer: l.customer, rateCents: l.rateCents, currency: l.currency, stops: l.stops.map((s) => ({ type: s.type, name: s.name, city: s.address?.city ?? null, state: s.address?.state ?? null, country: s.country, at: s.windowStart ? s.windowStart.toISOString() : null })), errors: l.errors })),
    };
  });
}

export async function importLoadsAction(form: FormData) {
  const { importLoads } = await import("@/domain/load-import");
  const r = await act(async (ctx) => {
    const { table, fileName } = await tableFrom(form);
    return importLoads(ctx, table, { book: form.get("book") === "1", fileName });
  });
  if (r.ok) touch();
  return r;
}
