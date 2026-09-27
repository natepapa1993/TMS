import { and, eq, inArray, notInArray, or, desc, gte, sql } from "drizzle-orm";
import { pdfText } from "@/lib/pdf-text";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { db } from "@/db/client";
import * as s from "@/db/schema";
import { assertCtx, systemCtx, type Ctx } from "@/lib/context";
import { issueToken, publicUrl, revokeTokensFor } from "@/lib/tokens";
import { advanceLeg, pendingMidStop, NotFoundError, ValidationError } from "./orders";
import { newId } from "@/lib/ids";
import { newToken } from "@/lib/tokens";
import { respondToTender, type TenderResponse } from "./tenders";
import { statusFor, subjectDocuments, uploadSubjectDocument } from "./compliance";
import { uploadOrderDocument, receiveCarrierBill, syncCarrierBills } from "./billing";
import { LEG_LABEL } from "./states";

/**
 * Carrier portal (spec Module 10): one persistent link per partner carrier — their offers, the loads they
 * are running, what they are owed, their compliance documents, and how they score. No login; the token is
 * the authorization and the carrier record is the boundary.
 */

const LEG_TYPE_LABEL: Record<string, string> = { mx: "Mexico", crossing: "Crossing", us: "US", domestic: "Domestic", equipment_move: "Equipment move" };
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
  return { days: 90, offered, answered, accepted, declined, expired, acceptancePct: answered ? Math.round((accepted / answered) * 100) : null, loads: legs.length, onTimePct: onTimeWindow ? Math.round((onTime / onTimeWindow) * 100) : null, onTimeOf: onTimeWindow, trackedPct: legs.length ? Math.round((tracked / legs.length) * 100) : null };
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
export async function portalAdvance(tenantId: string, carrierId: string, legId: string, to: s.LegState, note?: string | null) {
  const ctx = systemCtx(tenantId);
  const l = await ownLeg(tenantId, carrierId, legId);
  if (l.state === "en_route" && to === "en_route") {
    // a stop in between: "next" clocks it (arrive, then leave) before the delivery
    const stops = await db.select().from(s.stops).where(eq(s.stops.orderId, l.orderId));
    if (pendingMidStop(l, stops)) return advanceLeg(ctx, legId, "next", { source: "carrier", verified: false, note: note ?? undefined });
  }
  const next = NEXT[l.state];
  if (!next || next.to !== to) throw new ValidationError(`this load is ${LEG_LABEL[l.state]}; the next step is ${next ? LEG_LABEL[next.to] : "none"}`);
  return advanceLeg(ctx, legId, to, { source: "carrier", verified: false, note: note ?? undefined });
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
  const fmt = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");
  const stopLine = (label: string, st?: typeof from) => {
    T(label, 54, y, 8, bold, muted);
    T(st ? `${st.name}${st.address?.line1 ? `, ${st.address.line1}` : ""}${st.address?.city ? `, ${st.address.city}` : ""}${st.address?.state ? ` ${st.address.state}` : ""} ${st.country}` : "", 54, y - 13, 10);
    const w = st ? [st.windowStart && `from ${fmt(st.windowStart)}`, st.windowEnd && `to ${fmt(st.windowEnd)}`, st.appointment && "appointment"].filter(Boolean).join(" · ") : "";
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
