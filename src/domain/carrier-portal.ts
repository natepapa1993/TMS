import { and, eq, inArray, notInArray, or, desc, gte, sql } from "drizzle-orm";
import { pdfText } from "@/lib/pdf-text";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { assertCtx, systemCtx, type Ctx } from "@/lib/context";
import { issueToken, publicUrl, revokeTokensFor } from "@/lib/tokens";
import { advanceLeg, pendingMidStop, midStops, NotFoundError, ValidationError } from "./orders";
import { recordPosition } from "./tracking";
import { newId } from "@/lib/ids";
import { newToken } from "@/lib/tokens";
import { respondToTender, type TenderResponse } from "./tenders";
import { statusFor, subjectDocuments, uploadSubjectDocument } from "./compliance";
import { uploadOrderDocument, receiveCarrierBill, syncCarrierBills } from "./billing";
import { LEG_LABEL } from "./states";
import { HANDOFF } from "./zones";

/**
 * Carrier portal (spec Module 10): one persistent link per partner carrier — their offers, the loads they
 * are running, what they are owed, their compliance documents, and how they score. No login; the token is
 * the authorization and the carrier record is the boundary.
 */

const LEG_TYPE_LABEL: Record<string, string> = { mx: "Mexico", ca: "Canada", crossing: "Crossing", us: "US", domestic: "Domestic", equipment_move: "Equipment move" };
const NEXT: Partial<Record<s.LegState, { to: s.LegState; en: string; es: string }>> = {
  dispatched: { to: "accepted", en: "Accept this load", es: "Aceptar esta carga" },
  accepted: { to: "en_route_to_pickup", en: "Rolling to pickup", es: "En camino a cargar" },
  en_route_to_pickup: { to: "at_pickup", en: "Arrived at pickup", es: "Llegué a cargar" },
  at_pickup: { to: "loaded", en: "Loaded — leaving", es: "Cargado — saliendo" },
  loaded: { to: "en_route", en: "En route to delivery", es: "En ruta a entrega" },
  en_route: { to: "at_delivery", en: "Arrived at delivery", es: "Llegué a entregar" },
  at_delivery: { to: "completed", en: "Delivered — empty", es: "Entregado — vacío" },
};

export async function carrierPortalLink(ctx: Ctx, carrierId: string) {
  assertCtx(ctx);
  const [c] = await db.select().from(s.carriers).where(and(eq(s.carriers.tenantId, ctx.tenantId), eq(s.carriers.id, carrierId))).limit(1);
  if (!c) throw new NotFoundError("carrier", carrierId);
  const tok = await issueToken(ctx, "carrier_portal", carrierId, { label: c.name });
  return { url: publicUrl(`/c/${tok.token}`), name: c.name, email: c.dispatchEmail, whatsapp: c.whatsapp };
}

export async function revokeCarrierPortal(ctx: Ctx, carrierId: string) {
  assertCtx(ctx);
  await revokeTokensFor(ctx, "carrier_portal", carrierId);
}

async function loadCarrier(tenantId: string, carrierId: string) {
  const [c] = await db.select().from(s.carriers).where(and(eq(s.carriers.tenantId, tenantId), eq(s.carriers.id, carrierId))).limit(1);
  if (!c || c.archivedAt) throw new NotFoundError("carrier", carrierId);
  return c;
}

const place = (st?: typeof s.stops.$inferSelect | null) => (st ? { name: st.name, city: st.address?.city ?? null, state: st.address?.state ?? null, country: st.country, windowStart: st.windowStart, windowEnd: st.windowEnd, contact: st.contact, notes: st.notes } : null);

/** Everything the carrier's page shows. */
export async function carrierPortalView(tenantId: string, carrierId: string, now = new Date()) {
  const ctx = systemCtx(tenantId);
  const carrier = await loadCarrier(tenantId, carrierId);
  const [tenants] = await db.select({ name: s.tenants.name }).from(s.tenants).where(eq(s.tenants.id, tenantId)).limit(1);
  await syncCarrierBills(ctx).catch(() => null);
  const since = new Date(now.getTime() - 60 * 86400_000);
  const [legs, tenders, bills] = await Promise.all([
    db.select().from(s.legs).where(and(eq(s.legs.tenantId, tenantId), eq(s.legs.carrierId, carrierId), or(notInArray(s.legs.state, ["completed", "cancelled", "unassigned"]), gte(s.legs.completedAt, since)))).orderBy(desc(s.legs.updatedAt)),
    db.select().from(s.tenders).where(and(eq(s.tenders.tenantId, tenantId), eq(s.tenders.carrierId, carrierId), eq(s.tenders.state, "sent"), gte(s.tenders.expiresAt, now))),
    db.select().from(s.carrierBills).where(and(eq(s.carrierBills.tenantId, tenantId), eq(s.carrierBills.carrierId, carrierId))),
  ]);
  const orderIds = [...new Set([...legs.map((l) => l.orderId), ...tenders.map((t) => t.orderId)])];
  const [orders, stops] = orderIds.length ? await Promise.all([db.select().from(s.orders).where(inArray(s.orders.id, orderIds)), db.select().from(s.stops).where(inArray(s.stops.orderId, orderIds))]) : [[], []];
  const stopById = new Map(stops.map((x) => [x.id, x]));
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const acceptedTenders = legs.length ? await db.select().from(s.tenders).where(and(eq(s.tenders.tenantId, tenantId), inArray(s.tenders.legId, legs.map((l) => l.id)), eq(s.tenders.state, "accepted"))).orderBy(desc(s.tenders.respondedAt)) : [];
  // a POD on file for the leg's order (on a trip: for every shipment delivering on the leg)
  const podOn = new Set<string>();
  if (legs.length) {
    const { podTargetsForLeg } = await import("./tracking");
    const targetsByLeg = new Map<string, string[]>();
    for (const l of legs) targetsByLeg.set(l.id, await podTargetsForLeg(tenantId, l).catch(() => [l.orderId]));
    const all = [...new Set([...targetsByLeg.values()].flat())];
    const pods = all.length ? await db.select({ subjectId: s.documents.subjectId }).from(s.documents).where(and(eq(s.documents.tenantId, tenantId), eq(s.documents.subjectKind, "order"), inArray(s.documents.subjectId, all), eq(s.documents.code, "POD"), inArray(s.documents.status, ["present", "verified"]))) : [];
    const have = new Set(pods.map((p) => p.subjectId));
    for (const [legId, targets] of targetsByLeg) if (targets.length && targets.every((id) => have.has(id))) podOn.add(legId);
  }
  // one link per live leg for the carrier's own driver: the carrier's dispatcher forwards it
  const driverLinks = new Map<string, string>();
  for (const l of legs) if (!["completed", "cancelled", "unassigned", "planned"].includes(l.state)) driverLinks.set(l.id, (await carrierDriverLink(tenantId, l.id).catch(() => null))?.url ?? "");
  const legView = (l: typeof s.legs.$inferSelect) => {
    const o = orderById.get(l.orderId);
    const bill = bills.find((b) => b.legId === l.id);
    const at = acceptedTenders.find((t) => t.legId === l.id);
    return {
      id: l.id,
      seq: l.seq,
      type: LEG_TYPE_LABEL[l.type] ?? l.type,
      state: l.state,
      stateLabel: LEG_LABEL[l.state],
      next: (() => {
        const mid = pendingMidStop(l, stops.filter((x) => x.orderId === l.orderId));
        return mid ? { to: l.state, en: `${mid.which === "arrived" ? "Arrived at" : "Leaving"} ${mid.stop.name}`, es: `${mid.which === "arrived" ? "Llegamos a" : "Saliendo de"} ${mid.stop.name}` } : (NEXT[l.state] ?? null);
      })(),
      orderNumber: o?.orderNumber ?? "?",
      equipment: o?.equipment ?? null,
      cargoNote: o?.cargoNote ?? null,
      refs: o?.refs ?? {},
      rateCents: l.carrierRateCents,
      from: place(stopById.get(l.fromStopId ?? "")),
      to: place(stopById.get(l.toStopId ?? "")),
      driverName: at?.driverName ?? null,
      driverPhone: at?.driverPhone ?? null,
      unitNumber: at?.unitNumber ?? null,
      trailerNumber: at?.trailerNumber ?? null,
      completedAt: l.completedAt,
      podOnFile: podOn.has(l.id),
      driverLink: driverLinks.get(l.id) ?? null,
      bill: bill ? { id: bill.id, state: bill.state, expectedCents: bill.expectedCents + bill.accessorialCents, invoicedCents: bill.invoicedCents, approvedCents: bill.approvedCents, paidCents: bill.paidCents, paidAt: bill.paidAt, payDate: bill.payDate, shortPayNote: bill.shortPayNote, carrierInvoiceNumber: bill.carrierInvoiceNumber } : null,
    };
  };
  const offers = tenders.map((t) => {
    const l = legs.find((x) => x.id === t.legId) ?? null;
    const o = orderById.get(t.orderId);
    const from = l ? stopById.get(l.fromStopId ?? "") : undefined;
    const to = l ? stopById.get(l.toStopId ?? "") : undefined;
    return { id: t.id, token: t.token, legId: t.legId, orderNumber: o?.orderNumber ?? "?", type: l ? (LEG_TYPE_LABEL[l.type] ?? l.type) : "leg", rateCents: t.rateCents, currency: t.currency, expiresAt: t.expiresAt, message: t.message, from: place(from), to: place(to), equipment: o?.equipment ?? null, cargoNote: o?.cargoNote ?? null };
  });
  const active = legs.filter((l) => !["completed", "cancelled", "unassigned", "planned"].includes(l.state) && !tenders.some((t) => t.legId === l.id)).map(legView);
  const completed = legs.filter((l) => l.state === "completed").map(legView);
  const [compliance, docs, types] = await Promise.all([statusFor(ctx, "carrier", carrierId).catch(() => null), subjectDocuments(ctx, "carrier", carrierId), db.select().from(s.documentTypes).where(and(eq(s.documentTypes.tenantId, tenantId), eq(s.documentTypes.appliesTo, "carrier"), sql`${s.documentTypes.archivedAt} is null`))]);
  const score = await scorecard(ctx, carrierId, now);
  return {
    company: tenants?.name ?? "",
    carrier: { id: carrier.id, name: carrier.name, country: carrier.country, doNotUse: carrier.doNotUse },
    offers,
    active,
    completed,
    compliance: compliance ? { dispatchable: compliance.dispatchable, items: compliance.items } : null,
    docs: docs.map((d) => ({ id: d.id, typeName: types.find((t) => t.id === d.documentTypeId)?.name ?? d.code ?? "document", fileName: d.fileName, expiresAt: d.expiresAt, number: d.number, status: d.status, createdAt: d.createdAt })),
    types: types.map((t) => ({ id: t.id, name: t.name, tracksExpiry: t.tracksExpiry, required: t.required })),
    score,
  };
}

/** Offered / accepted / declined / expired in the last 90 days, on-time deliveries, tracking. */
export async function scorecard(ctx: Ctx, carrierId: string, now = new Date()) {
  assertCtx(ctx);
  const since = new Date(now.getTime() - 90 * 86400_000);
  const [tenders, legs] = await Promise.all([
    db.select().from(s.tenders).where(and(eq(s.tenders.tenantId, ctx.tenantId), eq(s.tenders.carrierId, carrierId), gte(s.tenders.createdAt, since))),
    db.select().from(s.legs).where(and(eq(s.legs.tenantId, ctx.tenantId), eq(s.legs.carrierId, carrierId), eq(s.legs.state, "completed"), gte(s.legs.completedAt, since))),
  ]);
  const offered = tenders.filter((t) => t.state !== "withdrawn").length;
  const accepted = tenders.filter((t) => t.state === "accepted").length;
  const declined = tenders.filter((t) => t.state === "declined").length;
  const expired = tenders.filter((t) => t.state === "expired" || (t.state === "sent" && t.expiresAt < now)).length;
  let onTimeWindow = 0;
  let onTime = 0;
  let tracked = 0;
  if (legs.length) {
    const legIds = legs.map((l) => l.id);
    const [arrivals, positions, stops] = await Promise.all([
      db.select({ legId: s.legEvents.legId, at: s.legEvents.at }).from(s.legEvents).where(and(inArray(s.legEvents.legId, legIds), eq(s.legEvents.kind, "transition"), eq(s.legEvents.toState, "at_delivery"))),
      db.select({ legId: s.positions.legId, n: sql<number>`count(*)` }).from(s.positions).where(inArray(s.positions.legId, legIds)).groupBy(s.positions.legId),
      db.select().from(s.stops).where(inArray(s.stops.id, legs.map((l) => l.toStopId).filter((x): x is string => !!x))),
    ]);
    for (const l of legs) {
      const stop = stops.find((x) => x.id === l.toStopId);
      const arrived = arrivals.find((a) => a.legId === l.id);
      if (stop?.windowEnd && arrived) {
        onTimeWindow++;
        if (arrived.at.getTime() <= stop.windowEnd.getTime()) onTime++;
      }
      if (positions.some((p) => p.legId === l.id && Number(p.n) > 0)) tracked++;
    }
  }
  const answered = accepted + declined + expired; // an offer still open is not a miss
  // rate variance: what they billed against what was agreed, over the bills they have sent
  const billed = legs.length ? await db.select({ expectedCents: s.carrierBills.expectedCents, accessorialCents: s.carrierBills.accessorialCents, invoicedCents: s.carrierBills.invoicedCents }).from(s.carrierBills).where(and(eq(s.carrierBills.tenantId, ctx.tenantId), inArray(s.carrierBills.legId, legs.map((l) => l.id)), sql`${s.carrierBills.invoicedCents} is not null`)) : [];
  const over = billed.filter((b) => (b.invoicedCents ?? 0) > b.expectedCents + b.accessorialCents).length;
  const varianceCents = billed.reduce((a, b) => a + Math.max(0, (b.invoicedCents ?? 0) - b.expectedCents - b.accessorialCents), 0);
  return { days: 90, offered, answered, accepted, declined, expired, acceptancePct: answered ? Math.round((accepted / answered) * 100) : null, loads: legs.length, onTimePct: onTimeWindow ? Math.round((onTime / onTimeWindow) * 100) : null, onTimeOf: onTimeWindow, trackedPct: legs.length ? Math.round((tracked / legs.length) * 100) : null, billed: billed.length, billedOver: over, overCents: varianceCents };
}

/** What the dispatcher sees when picking a carrier: the scorecard and whether compliance lets them run. */
export async function carrierPick(ctx: Ctx, carrierId: string) {
  assertCtx(ctx);
  const [score, st] = await Promise.all([scorecard(ctx, carrierId), statusFor(ctx, "carrier", carrierId).catch(() => null)]);
  return { score, dispatchable: st ? st.dispatchable : true, problems: st ? [...st.expired.map((x) => `${x} expired`), ...st.missing.map((x) => `${x} missing`)] : [] };
}

// ---------- actions from the portal ----------

export async function portalRespond(tenantId: string, carrierId: string, tenderId: string, r: TenderResponse) {
  const [t] = await db.select().from(s.tenders).where(and(eq(s.tenders.tenantId, tenantId), eq(s.tenders.id, tenderId), eq(s.tenders.carrierId, carrierId))).limit(1);
  if (!t) throw new NotFoundError("offer", tenderId);
  return respondToTender(t.token, r);
}

async function ownLeg(tenantId: string, carrierId: string, legId: string) {
  const [l] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, tenantId), eq(s.legs.id, legId), eq(s.legs.carrierId, carrierId))).limit(1);
  if (!l) throw new NotFoundError("load", legId);
  return l;
}

/** The carrier's dispatcher moves the leg one step (their driver may not have our app). */
export async function portalAdvance(tenantId: string, carrierId: string, legId: string, to: s.LegState, note?: string | null, seal?: string | null) {
  const ctx = systemCtx(tenantId);
  const l = await ownLeg(tenantId, carrierId, legId);
  if (l.state === "en_route" && to === "en_route") {
    // a stop in between: "next" clocks it (arrive, then leave) before the delivery
    const stops = await db.select().from(s.stops).where(eq(s.stops.orderId, l.orderId));
    if (pendingMidStop(l, stops)) return advanceLeg(ctx, legId, "next", { source: "carrier", verified: false, note: note ?? undefined, seal: seal ?? null });
  }
  const next = NEXT[l.state];
  if (!next || next.to !== to) throw new ValidationError(`this load is ${LEG_LABEL[l.state]}; the next step is ${next ? LEG_LABEL[next.to] : "none"}`);
  return advanceLeg(ctx, legId, to, { source: "carrier", verified: false, note: note ?? undefined, seal: seal ?? null });
}

// ---------- the partner carrier's driver, on one leg ----------

/**
 * A partner carrier's driver has no record with us and no ELD we can read; what they have is a phone.
 * One link per leg (spec §5 "phone pings"): the load, one button per step with GPS, positions every
 * two minutes while open. Works for the carrier's dispatcher to send from the portal and for ours to
 * send from the Track popup. Dies with the leg: nothing after it is completed or cancelled.
 */
export async function carrierDriverLink(tenantId: string, legId: string) {
  const ctx = systemCtx(tenantId);
  const [l] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, tenantId), eq(s.legs.id, legId))).limit(1);
  if (!l || l.assigneeKind !== "carrier" || !l.carrierId) throw new ValidationError("this leg is not with a partner carrier");
  const [at] = await db.select({ driverName: s.tenders.driverName, driverPhone: s.tenders.driverPhone }).from(s.tenders).where(and(eq(s.tenders.legId, legId), eq(s.tenders.state, "accepted"))).orderBy(desc(s.tenders.respondedAt)).limit(1);
  const tok = await issueToken(ctx, "carrier_driver", legId, { label: at?.driverName ?? "carrier driver" });
  return { url: publicUrl(`/g/${tok.token}`), driverName: at?.driverName ?? null, driverPhone: at?.driverPhone ?? null };
}

export async function carrierDriverView(tenantId: string, legId: string) {
  const [l] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, tenantId), eq(s.legs.id, legId))).limit(1);
  if (!l || !l.carrierId) throw new NotFoundError("load", legId);
  const [order, stops, carrier, tenant, at, orderLegs] = await Promise.all([
    db.select().from(s.orders).where(eq(s.orders.id, l.orderId)).limit(1).then((r) => r[0]),
    db.select().from(s.stops).where(eq(s.stops.orderId, l.orderId)).orderBy(s.stops.seq),
    loadCarrier(tenantId, l.carrierId),
    db.select({ name: s.tenants.name }).from(s.tenants).where(eq(s.tenants.id, tenantId)).limit(1).then((r) => r[0]),
    db.select({ driverName: s.tenders.driverName, trailerNumber: s.tenders.trailerNumber }).from(s.tenders).where(and(eq(s.tenders.legId, legId), eq(s.tenders.state, "accepted"))).orderBy(desc(s.tenders.respondedAt)).limit(1).then((r) => r[0]),
    db.select().from(s.legs).where(eq(s.legs.orderId, l.orderId)).orderBy(s.legs.seq),
  ]);
  const flow = await partnerFlow(l);
  const mid = pendingMidStop(l, stops);
  const done = ["completed", "cancelled", "unassigned", "planned", "declined"].includes(l.state);
  const next = done ? null : flow ? flowNext(flow) : mid ? { to: l.state, en: `${mid.which === "arrived" ? "Arrived at" : "Leaving"} ${mid.stop.name}`, es: `${mid.which === "arrived" ? "Llegué a" : "Saliendo de"} ${mid.stop.name}` } : (NEXT[l.state] ?? null);
  const stop = (id: string | null) => {
    const x = stops.find((st) => st.id === id);
    return x ? { id: x.id, name: x.name, type: x.type, country: x.country, address: x.address, windowStart: x.windowStart, windowEnd: x.windowEnd, contact: x.contact, notes: x.notes, arrivedAt: x.arrivedAt, departedAt: x.departedAt, refs: x.refs } : null;
  };
  const toStop = stops.find((x) => x.id === l.toStopId);
  // a drop at the border yard (or any hand-off) for the next truck: the caja number, its seal and a photo go to the crossing (M18)
  const nextLeg = orderLegs.find((x) => x.fromStopId === l.toStopId && x.id !== l.id);
  const handoff = toStop && HANDOFF.includes(toStop.type) && nextLeg ? { kind: toStop.type, crossing: nextLeg.type === "crossing", caja: at?.trailerNumber ?? null } : null;
  const { tenantContact } = await import("./company");
  const photos = await db.select({ code: s.documents.code }).from(s.documents).where(and(eq(s.documents.tenantId, tenantId), eq(s.documents.subjectKind, "order"), eq(s.documents.subjectId, l.orderId), inArray(s.documents.code, ["POD", "SEAL_PHOTO"]), inArray(s.documents.status, ["present", "verified"])));
  return {
    company: tenant?.name ?? "",
    dispatchPhone: (await tenantContact(tenantId)).dispatchPhone,
    carrier: carrier.name,
    driverName: at?.driverName ?? null,
    leg: { id: l.id, state: l.state, stateLabel: LEG_LABEL[l.state], type: LEG_TYPE_LABEL[l.type] ?? l.type, done: l.state === "completed" || l.state === "cancelled" },
    order: { orderNumber: order?.orderNumber ?? "?", equipment: order?.equipment ?? null, cargoNote: order?.cargoNote ?? null },
    from: stop(l.fromStopId),
    to: stop(l.toStopId),
    mids: midStops(l, stops).map((m) => stop(m.id)!),
    sealExpected: (() => {
      const mids = midStops(l, stops);
      const nextStopId = l.state === "en_route" ? (mids.find((m) => !m.arrivedAt)?.id ?? l.toStopId) : l.state === "loaded" ? l.toStopId : null;
      const seq = stops.find((x) => x.id === nextStopId)?.seq;
      if (seq == null) return null;
      return [...stops].filter((x) => x.seq < seq && x.sealOut).sort((p, q) => q.seq - p.seq)[0]?.sealOut ?? null;
    })(),
    next,
    wait: flow?.kind === "wait" ? { en: flow.en, es: flow.es } : null,
    handoff,
    podOnFile: photos.some((p) => p.code === "POD"),
    cajaPhotoOnFile: photos.some((p) => p.code === "SEAL_PHOTO"),
  };
}

/** A partner on a crossing leg walks the same ordered flow as our own driver: its leg steps to the caja, then the border. */
async function partnerFlow(l: typeof s.legs.$inferSelect) {
  if (l.type !== "crossing") return null;
  const [x] = await db.select().from(s.crossings).where(eq(s.crossings.legId, l.id)).limit(1);
  if (!x) return null;
  const X = await import("./crossing");
  return { ...X.crossingDriverNext(l.state, x.state), crossing: x, labels: (k: s.CrossingState) => X.stepLabel(k, x) };
}
function flowNext(f: NonNullable<Awaited<ReturnType<typeof partnerFlow>>>): { to: string; en: string; es: string; border?: boolean } | null {
  if (f.kind === "leg") return f.to === "loaded" ? { to: "loaded", en: "Caja picked up — loaded", es: "Caja enganchada — cargado" } : (Object.values(NEXT).find((n) => n?.to === f.to) ?? null);
  if (f.kind === "border") {
    const lb = f.labels(f.to);
    return { to: f.to, en: lb?.en ?? f.to, es: lb?.es ?? f.to, border: true };
  }
  return null;
}

/** The carrier's driver pressed the button: a position when the phone gave one, and the step, verified when it did. */
export async function carrierDriverStep(tenantId: string, legId: string, input: { lat?: number | null; lng?: number | null; accuracyM?: number | null; seal?: string | null; caja?: string | null }) {
  const ctx = systemCtx(tenantId);
  const [l] = await db.select().from(s.legs).where(and(eq(s.legs.tenantId, tenantId), eq(s.legs.id, legId))).limit(1);
  if (!l || !l.carrierId) throw new NotFoundError("load", legId);
  const hasPos = input.lat != null && input.lng != null;
  if (hasPos) await recordPosition(ctx, { source: "phone", lat: input.lat!, lng: input.lng!, accuracyM: input.accuracyM ?? null, legId: l.id }).catch(() => null);
  const ev = { source: "carrier" as const, verified: hasPos, lat: hasPos ? String(Number(input.lat).toFixed(6)) : undefined, lng: hasPos ? String(Number(input.lng).toFixed(6)) : undefined, note: "from the driver's phone", seal: input.seal ?? null };
  const flow = await partnerFlow(l);
  if (flow?.kind === "border") {
    const X = await import("./crossing");
    await X.step(ctx, flow.crossing.id, flow.to, { source: "carrier", verified: hasPos });
    const [after] = await db.select().from(s.legs).where(eq(s.legs.id, l.id)).limit(1);
    return after;
  }
  if (flow && flow.kind !== "leg") throw new ValidationError(flow.kind === "wait" ? `${flow.en} · ${flow.es}` : "wait for dispatch · espera a despacho");
  if (l.state === "en_route") {
    const stops = await db.select().from(s.stops).where(eq(s.stops.orderId, l.orderId));
    if (pendingMidStop(l, stops)) return advanceLeg(ctx, legId, "next", ev);
  }
  const next = NEXT[l.state];
  if (!next) throw new ValidationError("nothing further on this load");
  // dropping the caja at the border yard for the crossing truck: its number (and seal) go onto the crossing
  if (next.to === "completed") {
    const [toStop] = l.toStopId ? await db.select().from(s.stops).where(eq(s.stops.id, l.toStopId)).limit(1) : [];
    const [nextLeg] = l.toStopId ? await db.select().from(s.legs).where(and(eq(s.legs.orderId, l.orderId), eq(s.legs.fromStopId, l.toStopId))).limit(1) : [];
    if (toStop && HANDOFF.includes(toStop.type) && nextLeg) {
      const caja = input.caja?.trim();
      if (!caja && nextLeg.type === "crossing") throw new ValidationError("type the caja number before you leave it · escribe el número de caja", "caja");
      const moved = await advanceLeg(ctx, legId, next.to, ev);
      if (caja) {
        const { cajaFromCarrier } = await import("./crossing");
        const [c] = await db.select({ name: s.carriers.name }).from(s.carriers).where(eq(s.carriers.id, l.carrierId)).limit(1);
        await cajaFromCarrier(ctx, l.orderId, nextLeg.id, caja, `${c?.name ?? "carrier"} driver at ${toStop.name}`, input.seal ?? null);
      }
      return moved;
    }
  }
  return advanceLeg(ctx, legId, next.to, ev);
}

export async function carrierDriverPing(tenantId: string, legId: string, p: { lat: number; lng: number; accuracyM?: number | null; speedMph?: number | null; heading?: number | null }) {
  const [l] = await db.select({ id: s.legs.id, state: s.legs.state }).from(s.legs).where(and(eq(s.legs.tenantId, tenantId), eq(s.legs.id, legId))).limit(1);
  if (!l) throw new NotFoundError("load", legId);
  if (["completed", "cancelled", "unassigned"].includes(l.state)) return null; // the load is over; the phone stops mattering
  return recordPosition(systemCtx(tenantId), { source: "phone", lat: p.lat, lng: p.lng, accuracyM: p.accuracyM ?? null, speedMph: p.speedMph ?? null, heading: p.heading ?? null, legId: l.id });
}

/** Who is driving: kept on the accepted tender (created here when the leg was given by phone with no tender row). */
export async function portalSetDriver(tenantId: string, carrierId: string, legId: string, d: { driverName: string; driverPhone?: string | null; unitNumber?: string | null; trailerNumber?: string | null; by?: string | null }) {
  const l = await ownLeg(tenantId, carrierId, legId);
  if (!d.driverName?.trim()) throw new ValidationError("driver name", "driverName");
  if (l.state === "completed" || l.state === "cancelled") throw new ValidationError("this load is closed");
  const patch = { driverName: d.driverName.trim(), driverPhone: d.driverPhone?.trim() || null, unitNumber: d.unitNumber?.trim() || null, trailerNumber: d.trailerNumber?.trim() || null, updatedAt: new Date() };
  const [at] = await db.select().from(s.tenders).where(and(eq(s.tenders.tenantId, tenantId), eq(s.tenders.legId, legId), eq(s.tenders.state, "accepted"))).orderBy(desc(s.tenders.respondedAt)).limit(1);
  if (at) await db.update(s.tenders).set(patch).where(eq(s.tenders.id, at.id));
  else await db.insert(s.tenders).values({ id: newId(), tenantId, legId, orderId: l.orderId, carrierId, rateCents: l.carrierRateCents, currency: "USD", channel: "manual", token: newToken(), state: "accepted", expiresAt: new Date(), respondedAt: new Date(), respondedBy: d.by?.trim() || "carrier portal", ...patch });
  await db.insert(s.legEvents).values({ id: newId(), tenantId, legId, orderId: l.orderId, kind: "note", source: "carrier", note: `carrier assigned driver ${patch.driverName}${patch.driverPhone ? ` ${patch.driverPhone}` : ""}${patch.unitNumber ? ` · unit ${patch.unitNumber}` : ""}${patch.trailerNumber ? ` · trailer ${patch.trailerNumber}` : ""}` });
  return patch;
}

export async function portalUploadDocument(tenantId: string, carrierId: string, input: { documentTypeId: string; fileName: string; mimeType: string; bytes: Buffer; expiresAt?: Date | null; number?: string | null }) {
  const ctx = systemCtx(tenantId);
  await loadCarrier(tenantId, carrierId);
  return uploadSubjectDocument(ctx, "carrier", carrierId, { ...input, source: "carrier_portal" });
}

/** The carrier sends the POD for a leg they ran (at the delivery or after): the document our three-way check and the customer's invoice wait for. */
/** The caja photo at a border-yard drop (the partner driver's link): on the load's documents and the crossing's timeline. */
export async function portalUploadCajaPhoto(tenantId: string, carrierId: string, legId: string, file: { fileName: string; mimeType: string; bytes: Buffer }) {
  const ctx = systemCtx(tenantId);
  const l = await ownLeg(tenantId, carrierId, legId);
  if (!["at_delivery", "completed"].includes(l.state)) throw new ValidationError("take the caja photo at the yard · toma la foto de la caja en el patio");
  const row = await uploadOrderDocument(ctx, l.orderId, { code: "SEAL_PHOTO", fileName: file.fileName, mimeType: file.mimeType, bytes: file.bytes, source: "carrier_portal" });
  await db.insert(s.legEvents).values({ id: newId(), tenantId, legId: l.id, orderId: l.orderId, kind: "document", source: "carrier", verified: false, note: "Caja / seal photo from the carrier's driver" });
  return row;
}

export async function portalUploadPod(tenantId: string, carrierId: string, legId: string, file: { fileName: string; mimeType: string; bytes: Buffer }) {
  const ctx = systemCtx(tenantId);
  const l = await ownLeg(tenantId, carrierId, legId);
  if (!["at_delivery", "completed"].includes(l.state)) throw new ValidationError("send the POD once the load is at the delivery · manda el POD al llegar a la entrega");
  const { podTargetsForLeg } = await import("./tracking");
  const targets = await podTargetsForLeg(tenantId, l, l.state === "at_delivery" ? l.toStopId : null);
  if (!targets.length) throw new ValidationError("no shipment delivers on this leg");
  const rows = [];
  for (const orderId of targets) rows.push(await uploadOrderDocument(ctx, orderId, { code: "POD", fileName: file.fileName, mimeType: file.mimeType, bytes: file.bytes, source: "carrier_portal" }));
  await db.insert(s.legEvents).values({ id: newId(), tenantId, legId: l.id, orderId: l.orderId, kind: "document", source: "carrier", verified: false, note: `POD from the carrier portal${targets.length > 1 ? ` (${targets.length} shipments)` : ""}` });
  return rows;
}

/** The carrier bills a completed leg: amount, their invoice number, the PDF. Lands as "received" for the three-way check. */
export async function portalSubmitInvoice(tenantId: string, carrierId: string, legId: string, input: { amountCents: number; invoiceNumber: string; fileName?: string; mimeType?: string; bytes?: Buffer | null }) {
  const ctx = systemCtx(tenantId);
  const l = await ownLeg(tenantId, carrierId, legId);
  if (l.state !== "completed") throw new ValidationError("invoice after the load is delivered");
  if (!input.invoiceNumber?.trim()) throw new ValidationError("your invoice number", "invoiceNumber");
  if (!Number.isFinite(input.amountCents) || input.amountCents <= 0) throw new ValidationError("amount", "amountCents");
  await syncCarrierBills(ctx);
  const [bill] = await db.select().from(s.carrierBills).where(and(eq(s.carrierBills.tenantId, tenantId), eq(s.carrierBills.legId, legId))).limit(1);
  if (!bill) throw new NotFoundError("bill", legId);
  if (["approved", "scheduled", "paid"].includes(bill.state)) throw new ValidationError(`this load is already ${bill.state}`);
  let docId: string | null = null;
  if (input.bytes?.length) {
    const doc = await uploadOrderDocument(ctx, l.orderId, { code: "CARRIER_INVOICE", fileName: input.fileName ?? "invoice.pdf", mimeType: input.mimeType ?? "application/pdf", bytes: input.bytes, source: "carrier_portal" });
    docId = doc.id;
  }
  return receiveCarrierBill(ctx, bill.id, { invoicedCents: Math.round(input.amountCents), carrierInvoiceNumber: input.invoiceNumber.trim(), docId });
}

/** The rate confirmation for a leg we gave this carrier. */
export async function rateConPdf(tenantId: string, carrierId: string, legId: string): Promise<Uint8Array> {
  const carrier = await loadCarrier(tenantId, carrierId);
  const l = await ownLeg(tenantId, carrierId, legId);
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, l.orderId)).limit(1);
  const [tenant] = await db.select().from(s.tenants).where(eq(s.tenants.id, tenantId)).limit(1);
  const entities = await db.select().from(s.billingEntities).where(eq(s.billingEntities.tenantId, tenantId));
  const entity = entities.find((e) => e.id === order.billingEntityId) ?? entities.find((e) => e.isDefault) ?? entities[0];
  const stops = await db.select().from(s.stops).where(eq(s.stops.orderId, l.orderId));
  const from = stops.find((x) => x.id === l.fromStopId);
  const to = stops.find((x) => x.id === l.toStopId);
  const [tender] = await db.select().from(s.tenders).where(and(eq(s.tenders.legId, legId), eq(s.tenders.state, "accepted"))).orderBy(desc(s.tenders.respondedAt)).limit(1);
  const rate = tender?.rateCents ?? l.carrierRateCents ?? 0;
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.4, 0.45, 0.55);
  const T = (t: string, x: number, y: number, size = 10, f = font, color = ink) => page.drawText(pdfText(t), { x, y, size, font: f, color });
  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: ink });
  T(entity?.dba || entity?.legalName || tenant?.name || "Rate confirmation", 54, 760, 18, bold, rgb(1, 1, 1));
  T("RATE CONFIRMATION", 400, 760, 14, bold, rgb(0.6, 0.96, 0.89));
  T(`${order.orderNumber} leg ${l.seq}`, 400, 748, 9, font, rgb(0.8, 0.85, 0.9));
  let y = 705;
  T("CARRIER", 54, y, 8, bold, muted);
  T(carrier.name, 54, y - 13, 11, bold);
  T([carrier.mcNumber && `MC ${carrier.mcNumber}`, carrier.dotNumber && `DOT ${carrier.dotNumber}`, carrier.caat && `CAAT ${carrier.caat}`].filter(Boolean).join("  ") || "", 54, y - 26, 9, font, muted);
  T("FROM", 330, y, 8, bold, muted);
  T(entity?.legalName ?? tenant?.name ?? "", 330, y - 13, 11, bold);
  T([entity?.mcNumber && `MC ${entity.mcNumber}`, entity?.dotNumber && `DOT ${entity.dotNumber}`].filter(Boolean).join("  ") || "", 330, y - 26, 9, font, muted);
  y = 640;
  // the rate con prints each stop's time on that stop's clock, with the zone
  const { tenantZone } = await import("./company");
  const { fmtWindow, stopZone } = await import("@/lib/time");
  const companyZone = await tenantZone(tenantId);
  const stopLine = (label: string, st?: typeof from) => {
    T(label, 54, y, 8, bold, muted);
    T(st ? `${st.name}${st.address?.line1 ? `, ${st.address.line1}` : ""}${st.address?.city ? `, ${st.address.city}` : ""}${st.address?.state ? ` ${st.address.state}` : ""} ${st.country}` : "", 54, y - 13, 10);
    const w = st ? [fmtWindow(st.windowStart, st.windowEnd, stopZone(st, companyZone)), st.appointment && "appointment"].filter(Boolean).join(" · ") : "";
    if (w) T(w, 54, y - 26, 9, font, muted);
    if (st?.contact) T(`Contact: ${st.contact}`, 54, y - 39, 9, font, muted);
    y -= 60;
  };
  stopLine("PICKUP", from);
  stopLine("DELIVERY", to);
  T("EQUIPMENT", 54, y, 8, bold, muted);
  T(order.equipment.replace("_", " "), 54, y - 13, 10);
  if (order.cargoNote) {
    T("CARGO", 330, y, 8, bold, muted);
    T(order.cargoNote.slice(0, 60), 330, y - 13, 10);
  }
  y -= 40;
  T("REFERENCES", 54, y, 8, bold, muted);
  T(Object.entries(order.refs).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join("   ") || "-", 54, y - 13, 9);
  y -= 50;
  page.drawLine({ start: { x: 54, y }, end: { x: 558, y }, thickness: 0.8, color: ink });
  y -= 22;
  T("AGREED RATE", 54, y, 8, bold, muted);
  T(`${tender?.currency ?? "USD"} ${(rate / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`, 54, y - 16, 16, bold);
  T("all-in, fuel included, paid on receipt of a clean POD and your invoice referencing this order number", 54, y - 32, 9, font, muted);
  if (tender?.respondedBy) T(`Accepted by ${tender.respondedBy}${tender.respondedAt ? ` on ${tender.respondedAt.toISOString().slice(0, 10)}` : ""}${tender.driverName ? ` · driver ${tender.driverName}` : ""}`, 54, y - 50, 9, font, muted);
  T(`Generated by Crossline for ${carrier.name}`, 54, 40, 8, font, muted);
  return doc.save();
}
