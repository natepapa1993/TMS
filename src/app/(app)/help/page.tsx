import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";

export const metadata = { title: "Help" };

/** How the product works, screen by screen, and the rules it enforces. Written for the person who just signed up. */
const SECTIONS: { id: string; title: string; href: string; body: (string | { rule: string })[] }[] = [
  {
    id: "setup",
    title: "Settings: everything is master data",
    href: "/settings",
    body: [
      "Nothing is hard-coded. Billing entities (who invoices), users and roles, locations, ports, trucks, trailers, drivers, customers and brokers, partner carriers, carrier lane rates, customs brokers, document rules and EDI partners are all records you add, edit and archive. Every record has a quick-add popup with the essentials and a full screen with everything, a history of every change, and CSV import with a preview.",
      "Company settings hold the time zone (every public page and email uses it), the dispatch phone (a Call / WhatsApp button in every driver's app), fuel cost per mile for the P&L, the month-end close date, and the QuickBooks account names the export uses.",
      { rule: "A record in use cannot be archived; the screen says what is still pointing at it." },
    ],
  },
  {
    id: "dispatch",
    title: "Dispatch: the board and the one action",
    href: "/dispatch",
    body: [
      "Picking a partner carrier shows their last 90 days on the spot — loads, offers accepted, on time, tracked, bills over the agreed rate — and says so when compliance blocks them. Press n for a new order in four fields. An order is cut into legs by its stops: a Mexican leg, the crossing (Mexican border yard to the US yard, or the reverse), a US leg; or one domestic leg. Each leg is assigned on its own: our truck and driver, or a partner carrier by tender (email, WhatsApp, or by phone).",
      "The panel shows one primary action for where the order is: assign, send, mark accepted, then each milestone until delivered. Drivers press the same milestones in their app with GPS; carriers in their portal. A leg can be split, pulled back, held, or the unit put out of service, from the same panel.",
      "The driver app is one link per driver (on their record and in the Track popup), no install: today's load with the stops and navigation, one big button per step, the crossing packet, a seal photo while loading and the POD photo at the delivery (it lands on the order as the document billing waits for; on a tailgate trip, on every shipment getting off at that stop), their own documents with a photo of the renewal that waits for safety to confirm, their pay with a dispute on any line, and a line to dispatch that lands in Messages with a reply that reaches the app and WhatsApp.",
      "Seals are recorded where they happen: the driver (ours or a partner's, from their app or the carrier portal) types the seal applied when leaving a stop loaded and the seal found when opening at the next; the app tells them what it should be. A difference is a red flag naming both stops and numbers; the office can fix a typo on the stop and the flag clears. The tailgate manifest prints them.",
      "ETAs are ours, never the carrier's number: from the last verified position (a ping or a step pressed with GPS) to the next stop, at the corridor speed the company's own runs have taught (Mexico, US and the crossing learn separately; sensible defaults until then). A stop with no coordinates learns them the first time a driver arrives with a fix, and so does the location it came from, so the next run to the same plant has an ETA from the first ping. The ETA shows on the dispatch panel, the customer's tracking page and portal; one past the appointment window is a flag that clears itself.",
      "Flags watch the clock for you: a pickup opening soon with nobody accepted, an ETA past the appointment window, a window that closed with no arrival, a truck sitting past the customer's free time, a truck gone quiet, a declined tender, a crossing held. Red ones are emailed to the owner and dispatchers the minute they open; all of them clear themselves when the situation does.",
      "A partner carrier's leg is tracked through their driver's phone: the Track popup (and the carrier's own portal) has one link per leg with one button per step, GPS while it is open and the POD photo at the delivery. Their steps show as verified on the order and their last position on the customer's tracking page, like our own trucks.",
      { rule: "A B-1 driver never runs a US leg. There is no override." },
      { rule: "A brown-plated unit never runs beyond the border zone (no interior Mexico)." },
      { rule: "A CDL-only driver never runs interior Mexico; a Mexican carrier never runs a US leg." },
      { rule: "Expired licence, medical card, licencia federal, I-94 or plates block assignment and cannot be overridden. A missing document the owner requires blocks too, and the owner can override that one for 24 hours with a reason." },
      "Book again on any order copies its shape (customer, rate, equipment, stops) into a new draft for the next run of the lane.",
    ],
  },
  {
    id: "crossing",
    title: "Crossing: the workbench",
    href: "/crossing",
    body: [
      "Every crossing leg has a workbench: the checklist of documents the port, customer and your own rules require (carta porte, DODA, entry, ACE e-manifest, DTOPS, bill of lading, commercial invoice…), an upload for each with the AI reader to pull the fields, cross-checks between documents (trailer, plates, weights, piece counts, the DODA folio), eligibility of unit and driver for the crossing, the carta de retiro, and the packet that goes to the driver by WhatsApp or link.",
      "The board buckets crossings by what they are waiting on: documents, verification, ready to cross, crossing, held or returned, cleared. A dwell clock starts when the trailer is at the yard.",
      { rule: "The packet is built only when every required document is verified and every cross-check passes or is overridden with a reason; the truck is not dispatched to the bridge without it." },
    ],
  },
  {
    id: "compliance",
    title: "Compliance: rules, not reminders",
    href: "/compliance",
    body: [
      "Document types are your rules: what must be on file for a driver, truck, trailer or carrier, whether it tracks an expiry, how many days ahead to alert, whether it blocks dispatch, and for which legs (a FAST card matters on the crossing, not on a domestic run). The engine re-evaluates on every save and every hour, and its verdict is what the assign picker, the tender and the crossing read.",
      "The board shows every subject against every rule with expiring, expired and missing; snooze an alert with a reason, upload from the record, export to CSV, and keep the incident register. A daily digest goes to the owner and the safety role.",
      { rule: "A renewal a driver photographs in their app counts for nothing until safety confirms it on the record (fixing the dates if needed) — or sends it back with a reason the driver sees." },
    ],
  },
  {
    id: "billing",
    title: "Billing: the ledger",
    href: "/billing",
    body: [
      "Delivered orders wait in the queue until the documents the customer requires (POD, BOL, rate con…) are on file, the references they require (PO, ASN…) are on the order, and the charges match the rate con. Then one click makes a draft invoice per billing entity; issue it for a number, send it, record receipts and credits, mark disputes, watch AR aging, and close the month so nothing dated before it can change.",
      "Carrier bills expect the accepted tender rate and pass a three-way check (tender = invoice, POD on file) before approval; quick-pay discounts are per carrier and pay-when-paid is per customer. Drivers get weekly settlements from their pay rule with deductions and reimbursements, and see them in their app, where they can dispute a line.",
      "QuickBooks gets files: IIF for Desktop, CSV lists for Online; the account names live under Settings → Company and every record can carry its QuickBooks name.",
      { rule: "Nothing invoices without the required documents and references; a credit memo, not an edit, changes an issued invoice." },
    ],
  },
  {
    id: "reach",
    title: "Email agent, EDI, WhatsApp, portals",
    href: "/edi",
    body: [
      "EDI partners receive 204 tenders (over HTTP or a VAN mailbox over SFTP) that become draft orders with a 997 and a 990 back; every milestone goes out as a 214 and every issued invoice as a 210. Nothing leaves without a row in the log.",
      "The inbox agent reads dispatch@ (IMAP with an app password, or the mailbox forwarded to the company's inbound URL — both under Settings → Integrations). Every email becomes one card on Messages: what it is (rate con, tender, status question, broker document, detention, payment, quote), what it read (with the AI reader connected, the model reads the PDF too), which order it matched (the order number, the PO, the trailer on a live crossing, the sender's company) and what it will do: a draft order with the rate con attached, the document onto the order or the crossing, a reply drafted from verified tracking (in Spanish when asked in Spanish), detention computed from the stop clocks, a receipt on the invoice named. Approve, edit and approve, or ignore; nothing runs without the tap, and the email is the source on the timeline of whatever it touched.",
      { rule: "The agent never sends money, writes to a customer, changes a rate or dispatches a truck on its own: a card is a proposal until a person taps it." },
      "WhatsApp Business carries tenders, packets and tracking links and brings replies onto the load. Messages shows what came in (WhatsApp replies and what drivers write from their app) with a Reply that reaches the driver, and, under Sent, everything that went out with the provider's state.",
      "Each carrier and each customer has one permanent link (on their record): carriers see offers, their loads with one-tap milestones and the POD sent from the delivery (it is what their bill's three-way check waits for), rate cons, their pay and their documents; customers see their loads with tracking, PODs, invoices and can request a load, which lands on Dispatch as a flagged draft; in Spanish for a Mexican customer, one tap either way.",
    ],
  },
  {
    id: "reports",
    title: "Reports: the owner's six numbers",
    href: "/reports",
    body: ["Revenue per truck, empty miles, margin after carriers, driver pay, fuel and tolls, loads at risk, crossings pending, expiring documents — for this week, month to date, last month or a custom range; broken down by truck, driver, customer, lane, carrier or week, with a drill-down to the loads behind any number and CSV export. Trip costs on tailgate loads reach each shipment by its share.", "Every Monday after 7, the owner gets last week's numbers by email, when an email sender is connected under Settings → Integrations."],
  },
  {
    id: "tailgate",
    title: "Tailgate / LTL trips",
    href: "/trips",
    body: ["A trip is built from stops in driving order; every run of stops in one country is a leg and a US yard followed by a Mexican border yard is the crossing. Shipments from different customers ride between two of its stops with their own rate, references, documents and invoice; the load plan checks weight, linear feet and cube at every stop and refuses what does not fit. The trip runs on Dispatch as one row; the shipments follow its clocks and bill one by one."],
  },
  {
    id: "roles",
    title: "Roles",
    href: "/settings/users",
    body: ["Owner: everything. Dispatcher: orders, dispatch, records, billing view. Billing: invoices, receipts, carrier bills, settlements, records. Safety & compliance: rules, documents, overrides, incidents, records. Mexico office: orders and records, compliance view. Drivers, carriers and customers never sign in; they use their links."],
  },
];

export default async function HelpPage() {
  await requireCtx();
  return (
    <div>
      <PageHeader eyebrow="Crossline" title="How it works">
        The screens, in the order a day runs, and the rules the product enforces so nobody has to remember them.
      </PageHeader>
      <div className="px-7 pb-10 grid lg:grid-cols-[220px_1fr] gap-6 items-start">
        <nav className="card p-3 lg:sticky lg:top-5 text-[13px]">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="block px-2 py-1.5 rounded hover:bg-ground font-semibold">
              {s.title.split(":")[0]}
            </a>
          ))}
        </nav>
        <div className="space-y-5 max-w-3xl">
          {SECTIONS.map((s) => (
            <section key={s.id} id={s.id} className="card p-5">
              <div className="flex items-baseline justify-between gap-3">
                <div className="h2">{s.title}</div>
                <Link href={s.href} className="text-teal text-[13px] font-semibold whitespace-nowrap">
                  Open →
                </Link>
              </div>
              <div className="mt-2 space-y-2 text-[13.5px] leading-relaxed">
                {s.body.map((b, i) =>
                  typeof b === "string" ? (
                    <p key={i}>{b}</p>
                  ) : (
                    <p key={i} className="rounded-lg border border-teal/30 bg-teal-soft/40 px-3 py-2 text-[13px]">
                      <b>Rule.</b> {b.rule}
                    </p>
                  ),
                )}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
