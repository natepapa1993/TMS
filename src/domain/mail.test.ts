// Features: F-15 the inbox agent — emails to dispatch@ classified, read, matched and proposed as one card; nothing runs without a tap
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { truncateAll, makeTenant } from "@/test/helpers";
import { create } from "@/data/records";
import { db } from "@/db/client";
import { documents, integrations, outbox, legEvents, charges } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { newId } from "@/lib/ids";
import { createOrder, planLeg, dispatchLeg, acceptLeg, advanceLeg, getOrder, ValidationError } from "./orders";
import * as B from "./billing";
import * as M from "./mail";
import { parseEmail, memoryBox } from "@/integrations/mail";

const future = new Date(Date.now() + 365 * 86400_000);
const pdf = Buffer.from("%PDF-1.4 fixture rate confirmation");
let a: Awaited<ReturnType<typeof makeTenant>>;
let f: { rxo: string; magna: string; t2104: string; reyes: string };

/** A MIME message the way a mail client would send it: text (and an optional PDF) under one boundary. */
function mime(o: { from: string; fromName?: string; to?: string; subject: string; text: string; attachment?: { name: string; bytes: Buffer; type?: string }; messageId?: string; date?: string }) {
  const b = "----=_Part_" + Math.random().toString(36).slice(2);
  const head = [`From: ${o.fromName ? `"${o.fromName}" <${o.from}>` : o.from}`, `To: ${o.to ?? "dispatch@247expedite.test"}`, `Subject: ${o.subject}`, `Date: ${o.date ?? new Date().toUTCString()}`, `Message-ID: <${o.messageId ?? newId() + "@test"}>`, "MIME-Version: 1.0"];
  if (!o.attachment) return [...head, "Content-Type: text/plain; charset=utf-8", "", o.text].join("\r\n");
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${b}"`,
    "",
    `--${b}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.text,
    `--${b}`,
    `Content-Type: ${o.attachment.type ?? "application/pdf"}; name="${o.attachment.name}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${o.attachment.name}"`,
    "",
    o.attachment.bytes.toString("base64"),
    `--${b}--`,
  ].join("\r\n");
}

beforeEach(async () => {
  await truncateAll();
  a = await makeTenant("24:7");
  await create(a, "billingEntity", { legalName: "24/7 Expedite LLC", country: "US", invoicePrefix: "247", isDefault: true });
  const rxo = await create(a, "customer", { name: "RXO", kind: "broker", termsDays: 30, requiredDocs: [], billingEmail: "ap@rxo.test", contacts: [{ name: "Ana", email: "ana.lopez@rxo.test" }] });
  const magna = await create(a, "customer", { name: "Magna", kind: "customer", termsDays: 45, requiredDocs: [], detentionFreeMinutes: 60 });
  const t2104 = await create(a, "truck", { unitNumber: "2104", usPlate: "TX2104", usPlateExpires: future, dotInspectionExpires: future });
  const reyes = await create(a, "driver", { name: "Daniel Reyes", driverType: "CDL", licenseExpires: future, medicalExpires: future, currentTruckId: t2104.id });
  f = { rxo: rxo.id, magna: magna.id, t2104: t2104.id, reyes: reyes.id };
});
afterEach(() => vi.unstubAllGlobals());

const usOrder = (customerId: string, po: string) => createOrder(a, { customerId, rateCents: 180000, refs: { po }, stops: [{ type: "pickup", name: "Laredo Yard", country: "US", address: { city: "Laredo", state: "TX" } }, { type: "delivery", name: "Toyota San Antonio", country: "US", address: { city: "San Antonio", state: "TX" } }], book: true });

describe("parsing", () => {
  it("reads sender, subject, text and the PDF; a message with no Message-ID gets a hash; junk attachments are dropped", async () => {
    const p = await parseEmail(mime({ from: "Ana.Lopez@RXO.test", fromName: "Ana Lopez", subject: "Rate Confirmation 4500991", text: "See attached.\r\nRate: $2,850.00", attachment: { name: "RC_4500991.pdf", bytes: pdf } }));
    expect(p.from).toBe("ana.lopez@rxo.test");
    expect(p.fromName).toBe("Ana Lopez");
    expect(p.subject).toBe("Rate Confirmation 4500991");
    expect(p.text).toContain("Rate: $2,850.00");
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments[0]).toMatchObject({ fileName: "RC_4500991.pdf", mimeType: "application/pdf" });
    expect(p.messageId).toMatch(/@test>?$/);
    const noId = await parseEmail("From: x@y.test\r\nSubject: hi\r\n\r\nhello");
    expect(noId.messageId).toMatch(/^sha256:/);
    const junk = await parseEmail(mime({ from: "x@y.test", subject: "logo", text: "x", attachment: { name: "a.exe", bytes: Buffer.from("MZ"), type: "application/octet-stream" } }));
    expect(junk.attachments).toHaveLength(0);
  });
});

describe("rules", () => {
  it("classify by subject first, then body; read references, rate, trailer and seal off the text", () => {
    expect(M.classifyByRules({ subject: "Rate Confirmation – PO 4500991", text: "", attachments: [] })).toMatchObject({ kind: "rate_con", confidence: 75 });
    expect(M.classifyByRules({ subject: "26-00012", text: "Where is the truck? ETA to Arlington?", attachments: [] }).kind).toBe("status_request");
    expect(M.classifyByRules({ subject: "DODA lista", text: "Adjunto DODA y pedimento", attachments: [] }).kind).toBe("broker_doc");
    expect(M.classifyByRules({ subject: "Remittance advice", text: "ACH payment for invoice 247-000004", attachments: [] }).kind).toBe("remittance");
    expect(M.classifyByRules({ subject: "Detention on 26-00003", text: "", attachments: [] }).kind).toBe("dispute");
    expect(M.classifyByRules({ subject: "Lunch on Friday", text: "tacos?", attachments: [] })).toMatchObject({ kind: "noise" });
    const ex = M.extractByRules({ subject: "Load 26-00012 — PO 4500991", text: "Rate: $2,850.00\nTrailer # 10743\nSeal: MX-4471\nPickup: Planta Monterrey\nDelivery: GM Arlington\n53' dry van\nInvoice 247-000004" });
    expect(ex.orderNumber?.value).toBe("26-00012");
    expect(ex.po?.value).toBe("4500991");
    expect(ex.rate?.value).toBe(2850);
    expect(ex.trailer?.value).toBe("10743");
    expect(ex.seal?.value).toBe("MX-4471");
    expect(ex.pickupName?.value).toBe("Planta Monterrey");
    expect(ex.deliveryName?.value).toBe("GM Arlington");
    const sides = M.extractByRules({ subject: "", text: "Pickup: Planta Monterrey, Apodaca NL MX\nDelivery: GM Arlington, TX" });
    expect(sides.pickupCountry?.value).toBe("MX");
    expect(sides.deliveryCountry?.value).toBe("US");
    expect(ex.invoiceNumber?.value).toBe("247-000004");
  });
});

describe("the pipeline without a model", () => {
  it("a rate con from a customer's address proposes a draft order with the PDF as its rate con; approval creates it, once", async () => {
    const r = await M.receiveRawEmail(a.tenantId, mime({ from: "ana.lopez@rxo.test", fromName: "Ana Lopez", subject: "Rate Confirmation PO 4500991", text: "Pickup: Planta Monterrey, Apodaca NL MX\nDelivery: GM Arlington, TX\nRate: $2,850.00\n53' dry van\n26 pallets seats 38,000 lb", attachment: { name: "RC_4500991.pdf", bytes: pdf } }));
    expect(r.duplicate).toBe(false);
    expect(r.kind).toBe("rate_con");
    const inbox = await M.mailInbox(a);
    expect(inbox).toHaveLength(1);
    const card = inbox[0];
    expect(card.state).toBe("proposed");
    expect(card.classifier).toBe("rules");
    expect(card.attachments[0].fileName).toBe("RC_4500991.pdf");
    expect(card.proposal.action).toBe("create_order");
    if (card.proposal.action !== "create_order") throw new Error();
    expect(card.proposal.customerName).toBe("RXO"); // the sender is on RXO's contacts
    expect(card.proposal.rateCents).toBe(285000);
    expect(card.proposal.refs.po).toBe("4500991");
    expect(card.proposal.equipment).toBe("53_dry");
    expect(card.proposal.stops[0].name).toContain("Planta Monterrey");
    expect(card.proposal.stops[0].country).toBe("MX"); // "Apodaca NL MX" is Mexico
    expect(card.proposal.template).toBe("mx_crossing_us");
    expect(card.proposal.stops[card.proposal.stops.length - 1].name).toContain("GM Arlington");
    expect(card.proposal.attachAs).toBe("RATE_CON");
    // the same email again is not a second card
    expect((await M.receiveRawEmail(a.tenantId, mime({ from: "ana.lopez@rxo.test", subject: "x", text: "x", messageId: card.messageId.replace(/[<>]/g, "") }))).duplicate).toBe(true);
    // approve → a draft order, source email, with the rate con on it; the email is on the timeline
    const ok = await M.approveMail(a, card.id);
    expect(ok.result).toMatch(/draft order 26-00001 created with the rate con attached/);
    const o = await getOrder(a, ok.orderId!);
    expect(o.order.state).toBe("draft");
    expect(o.order.source).toBe("email");
    expect(o.order.rateCents).toBe(285000);
    expect(o.order.refs.po).toBe("4500991");
    expect(o.order.customerId).toBe(f.rxo);
    const docs = await db.select().from(documents).where(and(eq(documents.subjectKind, "order"), eq(documents.subjectId, o.order.id)));
    expect(docs.map((d) => [d.code, d.source])).toEqual([["RATE_CON", "email"]]);
    const evs = await db.select().from(legEvents).where(eq(legEvents.orderId, o.order.id));
    expect(evs.some((e) => e.note?.includes("email from Ana Lopez"))).toBe(true);
    await expect(M.approveMail(a, card.id)).rejects.toThrow(/already executed/);
    expect((await M.mailInbox(a)).length).toBe(0);
    expect((await M.mailInbox(a, { all: true }))[0].state).toBe("executed");
  });

  it("no customer recognised → the card says so and approval waits for the person to pick one; a rate con citing an order attaches instead", async () => {
    await M.receiveRawEmail(a.tenantId, mime({ from: "someone@unknown-broker.test", subject: "Load confirmation", text: "Pickup: Laredo TX\nDelivery: Dallas TX\nTotal $900", attachment: { name: "conf.pdf", bytes: pdf } }));
    const [card] = await M.mailInbox(a);
    if (card.proposal.action !== "create_order") throw new Error(card.proposal.action);
    expect(card.proposal.customerId).toBeNull();
    expect(card.proposal.summary).toContain("customer to pick");
    await expect(M.approveMail(a, card.id)).rejects.toBeInstanceOf(ValidationError);
    expect((await M.mailInbox(a, { all: true }))[0].state).toBe("failed");
    await M.retryMail(a, card.id);
    const ok = await M.approveMail(a, card.id, { customerId: f.magna, rateCents: 95000 });
    expect((await getOrder(a, ok.orderId!)).order).toMatchObject({ customerId: f.magna, rateCents: 95000, state: "draft" });
    // a rate con that cites an existing order attaches to it
    const o = await usOrder(f.rxo, "PO-77");
    await M.receiveRawEmail(a.tenantId, mime({ from: "ap@rxo.test", subject: `Rate con for ${o.order.orderNumber}`, text: "Rate $1,800.00 — see attached", attachment: { name: "rc.pdf", bytes: pdf } }));
    const [c2] = await M.mailInbox(a);
    expect(c2.orderId).toBe(o.order.id);
    expect(c2.matchReason).toContain(o.order.orderNumber);
    expect(c2.proposal).toMatchObject({ action: "attach_document", code: "RATE_CON", orderNumber: o.order.orderNumber });
    const r2 = await M.approveMail(a, c2.id);
    expect(r2.result).toContain("attached to");
    const docs = await db.select().from(documents).where(and(eq(documents.subjectKind, "order"), eq(documents.subjectId, o.order.id), eq(documents.code, "RATE_CON")));
    expect(docs).toHaveLength(1);
  });

  it("\"where is my truck\" on a moving load drafts a reply from verified tracking (Spanish when asked in Spanish); approval sends it through the outbox", async () => {
    const o = await usOrder(f.rxo, "PO-9");
    const leg = o.legs[0].id;
    await planLeg(a, leg, { kind: "truck", truckId: f.t2104, driverId: f.reyes });
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg);
    for (const st of ["en_route_to_pickup", "at_pickup", "loaded"] as const) await advanceLeg(a, leg, st, { source: "driver_app" });
    await advanceLeg(a, leg, "en_route", { source: "driver_app", verified: true, lat: "27.5064", lng: "-99.5075" });
    const { recordPosition } = await import("./tracking");
    await recordPosition(a, { source: "driver_app", lat: 27.6, lng: -99.4, truckId: f.t2104, legId: leg, place: "I-35 north of Laredo" });
    await M.receiveRawEmail(a.tenantId, mime({ from: "ana.lopez@rxo.test", fromName: "Ana Lopez", subject: `ETA on ${o.order.orderNumber}?`, text: "Hi, where is the truck on this one? Consignee is asking." }));
    const [card] = await M.mailInbox(a);
    expect(card.kind).toBe("status_request");
    expect(card.proposal.action).toBe("reply");
    if (card.proposal.action !== "reply") throw new Error();
    expect(card.proposal.to).toBe("ana.lopez@rxo.test");
    expect(card.proposal.subject).toBe(`Re: ETA on ${o.order.orderNumber}?`);
    expect(card.proposal.body).toContain("Hi Ana,");
    expect(card.proposal.body).toContain(`left Laredo Yard`);
    expect(card.proposal.body).toContain("heading to Toyota San Antonio");
    expect(card.proposal.body).toContain("Last GPS position");
    expect(card.proposal.body).not.toMatch(/1,800|180000/);
    const r = await M.approveMail(a, card.id, { body: card.proposal.body + "\nCall me with questions." });
    expect(r.result).toMatch(/logged — connect an email sender/); // no sender in tests
    const [sent] = await db.select().from(outbox).where(eq(outbox.subjectKind, "mail_reply"));
    expect(sent.to).toBe("ana.lopez@rxo.test");
    expect(sent.body).toContain("Call me with questions.");
    // en español
    await M.receiveRawEmail(a.tenantId, mime({ from: "ana.lopez@rxo.test", fromName: "Ana Lopez", subject: `${o.order.orderNumber}`, text: "Hola, ¿dónde va la unidad? Gracias" }));
    const [es] = await M.mailInbox(a);
    if (es.proposal.action !== "reply") throw new Error();
    expect(es.proposal.body).toContain("Hola Ana");
    expect(es.proposal.body).toContain("salió de Laredo Yard");
  });

  it("a broker document attaches to the crossing by trailer; a detention email proposes the computed charge; a remittance proposes the receipt on the invoice it names", async () => {
    // crossing order with a caja named
    const x = await createOrder(a, { customerId: f.rxo, rateCents: 285000, stops: [{ type: "pickup", name: "Planta Monterrey", country: "MX" }, { type: "border_yard", name: "Santa Fe", country: "MX" }, { type: "yard", name: "Laredo", country: "US" }, { type: "delivery", name: "GM Arlington", country: "US" }], book: true });
    const X = await import("./crossing");
    const [xr] = await db.select().from((await import("@/db/schema")).crossings).where(eq((await import("@/db/schema")).crossings.orderId, x.order.id));
    await X.setCrossingDetails(a, xr.id, { trailerNumber: "10743" });
    await M.receiveRawEmail(a.tenantId, mime({ from: "monitor@nadglobal.test", fromName: "NAD Monitor", subject: "DODA lista — caja 10743", text: "Buen día, adjunto DODA para la caja 10743. Pedimento 26 24 3456 6001234.", attachment: { name: "DODA_10743.pdf", bytes: pdf } }));
    const [bd] = await M.mailInbox(a);
    expect(bd.kind).toBe("broker_doc");
    expect(bd.matchReason).toContain("trailer 10743");
    expect(bd.proposal).toMatchObject({ action: "attach_document", code: "doda", crossingId: xr.id });
    const r1 = await M.approveMail(a, bd.id);
    expect(r1.result).toContain("attached to the crossing");
    const xdocs = await db.select().from(documents).where(and(eq(documents.subjectKind, "crossing"), eq(documents.subjectId, xr.id)));
    expect(xdocs.map((d) => [d.code, d.source])).toEqual([["doda", "email"]]);

    // detention: a delivered load that sat 3 h at Magna with 60 min free
    const o = await usOrder(f.magna, "PO-D");
    const leg = o.legs[0].id;
    await planLeg(a, leg, { kind: "truck", truckId: f.t2104, driverId: f.reyes });
    await dispatchLeg(a, leg);
    await acceptLeg(a, leg);
    const t0 = new Date(Date.now() - 10 * 3600_000);
    const at = (h: number) => new Date(t0.getTime() + h * 3600_000);
    await advanceLeg(a, leg, "en_route_to_pickup", { at: at(0) });
    await advanceLeg(a, leg, "at_pickup", { at: at(1) });
    await advanceLeg(a, leg, "loaded", { at: at(1.5) });
    await advanceLeg(a, leg, "en_route", { at: at(1.5) });
    await advanceLeg(a, leg, "at_delivery", { at: at(4) });
    await advanceLeg(a, leg, "completed", { at: at(7) });
    await M.receiveRawEmail(a.tenantId, mime({ from: "ap@magna.test", subject: `Detention on ${o.order.orderNumber}`, text: "Our driver waited three hours at the dock. Please advise on detention." }));
    const [dd] = await M.mailInbox(a);
    expect(dd.proposal).toMatchObject({ action: "detention", orderNumber: o.order.orderNumber });
    const r2 = await M.approveMail(a, dd.id);
    expect(r2.result).toMatch(/1 detention line added/);
    const ch = await db.select().from(charges).where(and(eq(charges.orderId, o.order.id), eq(charges.kind, "detention")));
    expect(ch).toHaveLength(1);
    expect(ch[0].description).toContain("Toyota San Antonio");

    // remittance on an issued invoice
    await B.acceptRateConMismatch(a, o.order.id, "detention approved by Magna");
    const inv = await B.createInvoice(a, [o.order.id]);
    const issued = await B.issueInvoice(a, inv.id, {});
    await M.receiveRawEmail(a.tenantId, mime({ from: "ap@magna.test", subject: "Remittance advice", text: `ACH payment sent today for invoice ${issued.number}: $1,800.00. Ref MAG-88121.` }));
    const [rm] = await M.mailInbox(a);
    expect(rm.kind).toBe("remittance");
    expect(rm.proposal).toMatchObject({ action: "receipt", invoiceNumber: issued.number, amountCents: 180000 }); // the amount in the text, not the (larger) balance
    const r3 = await M.approveMail(a, rm.id);
    expect(r3.result).toContain("recorded on");
    expect((await B.invoiceById(a, inv.id)).invoice.state).toBe("partially_paid"); // $1,800 of the $1,800 + detention

    // noise is filed without a card; ignore works on a card
    await M.receiveRawEmail(a.tenantId, mime({ from: "news@vendor.test", subject: "Our summer webinar", text: "Join us Thursday." }));
    expect((await M.mailInbox(a)).length).toBe(0);
    await M.receiveRawEmail(a.tenantId, mime({ from: "ap@rxo.test", subject: "quote please", text: "How much Laredo to Dallas, 53 dry?" }));
    const [q] = await M.mailInbox(a);
    expect(q.kind).toBe("carrier_quote");
    await M.ignoreMail(a, q.id, "answered by phone");
    expect((await M.mailInbox(a)).length).toBe(0);
  });

  it("the IMAP poll pulls new messages once each and remembers the last uid; another company's mailbox is not touched", async () => {
    const box = memoryBox([mime({ from: "ap@rxo.test", subject: "Rate con PO 1", text: "Rate $500", attachment: { name: "rc.pdf", bytes: pdf } })]);
    await db.insert(integrations).values({ id: newId(), tenantId: a.tenantId, provider: "mailbox", enabled: true, config: { host: "imap.test", user: "dispatch@test", password: "x", inboundToken: "inb-1" } });
    let r = await M.pollMail(a.tenantId, box);
    expect(r).toMatchObject({ received: 1, duplicates: 0, lastUid: 1 });
    r = await M.pollMail(a.tenantId, box);
    expect(r).toMatchObject({ received: 0, lastUid: 1 });
    box.push(mime({ from: "ap@rxo.test", subject: "Rate con PO 2", text: "Rate $600" }));
    r = await M.pollMail(a.tenantId, box);
    expect(r).toMatchObject({ received: 1, lastUid: 2 });
    expect((await M.mailInbox(a)).length).toBe(2);
    const [integ] = await db.select().from(integrations).where(eq(integrations.tenantId, a.tenantId));
    expect(integ.config.lastUid).toBe("2");
    expect(integ.lastResult).toContain("1 received");
    const other = await makeTenant("Other");
    expect(await M.pollMail(other.tenantId)).toEqual({ skipped: true });
    expect((await M.mailInbox(other)).length).toBe(0);
    expect((await M.integrationByInboundToken("inb-1"))?.tenantId).toBe(a.tenantId);
    expect(await M.integrationByInboundToken("nope")).toBeNull();
  });
});

describe("the pipeline with the model", () => {
  it("the model's classification and fields win when it is sure; a model failure falls back to rules and is noted on the integration", async () => {
    await db.insert(integrations).values({ id: newId(), tenantId: a.tenantId, provider: "extractor", enabled: true, config: { apiKey: "sk-test" } });
    const seen: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "classify_email", input: { kind: { value: "rate_con", confidence: 0.93 }, customerName: { value: "Magna", confidence: 0.9 }, rate: { value: "3,100", confidence: 0.95 }, currency: { value: "USD", confidence: 0.9 }, pickupName: { value: "Magna Ramos Arizpe", confidence: 0.9 }, pickupCity: { value: "Ramos Arizpe", confidence: 0.9 }, pickupState: { value: "COAH", confidence: 0.9 }, pickupCountry: { value: "MX", confidence: 0.95 }, deliveryName: { value: "Magna Arlington", confidence: 0.9 }, deliveryState: { value: "TX", confidence: 0.9 }, deliveryCountry: { value: "US", confidence: 0.95 }, po: { value: "5700489439", confidence: 0.97 }, equipment: { value: "53 dry", confidence: 0.8 }, cargo: { value: "26 pallets seats, 38,000 lb", confidence: 0.8 } } }] }), { status: 200 });
    });
    await M.receiveRawEmail(a.tenantId, mime({ from: "no-reply@transport-mgmt.test", subject: "Load 88213 confirmation", text: "(see attached)", attachment: { name: "88213.pdf", bytes: pdf } }));
    expect(seen).toHaveLength(1);
    const req = seen[0] as { tools: { name: string }[]; messages: { content: { type: string }[] }[] };
    expect(req.tools[0].name).toBe("classify_email");
    expect(req.messages[0].content[0].type).toBe("document"); // the PDF went along
    const [card] = await M.mailInbox(a);
    expect(card.classifier).toBe("claude-sonnet-4-5");
    expect(card.kind).toBe("rate_con");
    expect(card.confidence).toBe(93);
    if (card.proposal.action !== "create_order") throw new Error(card.proposal.action);
    expect(card.proposal.customerName).toBe("Magna"); // by the name the model read
    expect(card.proposal.rateCents).toBe(310000);
    expect(card.proposal.template).toBe("mx_crossing_us");
    expect(card.proposal.stops.map((st) => st.country)).toEqual(["MX", "MX", "US", "US"]);
    expect(card.proposal.stops[0]).toMatchObject({ name: "Magna Ramos Arizpe", city: "Ramos Arizpe", state: "COAH" });
    expect(card.proposal.refs.po).toBe("5700489439");
    expect(card.extracted.cargo?.value).toBe("26 pallets seats, 38,000 lb");
    // the model is down: rules carry on, the integration says why
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 }));
    await M.receiveRawEmail(a.tenantId, mime({ from: "ap@rxo.test", subject: "Rate confirmation PO 1", text: "Rate $700", attachment: { name: "rc.pdf", bytes: pdf } }));
    const [c2] = await M.mailInbox(a);
    expect(c2.classifier).toBe("rules");
    expect(c2.kind).toBe("rate_con");
    const [integ] = await db.select().from(integrations).where(and(eq(integrations.tenantId, a.tenantId), eq(integrations.provider, "extractor")));
    expect(integ.lastError).toContain("529");
  });
});
