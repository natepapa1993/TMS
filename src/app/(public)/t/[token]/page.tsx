import Link from "next/link";
import { tenderByToken } from "@/domain/tenders";
import { fmtWhen, fmtWindow, stopZone } from "@/lib/time";
import { tenantZone } from "@/domain/company";
import { TENDER_COPY, tenderLang, type TenderCopy } from "@/lib/tender-copy";
import { TenderForm } from "./form";
import { Pill } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Load offer" };

type StopRow = { name: string; type: string; country: string; windowStart: Date | null; windowEnd: Date | null; appointment: boolean; notes: string | null; contact: string | null; refs: Record<string, string>; address?: { line1?: string; city?: string; state?: string; postalCode?: string } | null } | null;

const place = (st: StopRow) => (st ? [st.name, [st.address?.line1, st.address?.city, [st.address?.state, st.address?.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ")] : ["—", ""]);
const EQUIPMENT: Record<string, [string, string]> = { "53_dry": ["53' dry van", "Caja seca 53'"], "53_reefer": ["53' reefer", "Caja refrigerada 53'"], "48_dry": ["48' dry van", "Caja seca 48'"], flatbed: ["Flatbed", "Plataforma"], sprinter: ["Sprinter", "Sprinter"], straight: ["Straight truck", "Rabón / torton"], power_only: ["Power only", "Solo tractor"] };

/** The carrier's offer: the whole load at a glance, each stop's time on that stop's clock, in the carrier's language. */
export default async function TenderPage({ params, searchParams }: PageProps<"/t/[token]">) {
  const { token } = await params;
  const sp = await searchParams;
  const t = await tenderByToken(token);
  const lang = tenderLang(t?.carrier?.country, typeof sp.lang === "string" ? sp.lang : null);
  const c: TenderCopy = TENDER_COPY[lang];
  if (!t || !t.leg || !t.order) {
    return (
      <div className="card p-6 text-center mt-10">
        <div className="h2">This link isn&apos;t valid · Este enlace no es válido</div>
        <p className="text-muted mt-1">Ask the dispatcher who sent it for a new one. · Pida uno nuevo a quien se lo envió.</p>
      </div>
    );
  }
  const zone = await tenantZone(t.tender.tenantId);
  const { tender, leg, order, carrier, tenant, from, to } = t;
  const fromZone = from ? stopZone(from, zone) : zone;
  const toZone = to ? stopZone(to, zone) : zone;
  const rate = tender.rateCents != null ? `${tender.currency} ${(tender.rateCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : c.rateTbc;
  const [fromName, fromAddr] = place(from);
  const [toName, toAddr] = place(to);
  const open = tender.state === "sent";
  const freight = order.freight ?? [];
  const pieces = freight.reduce((a, f) => a + (f.pieces ?? 0), 0) || order.pieces || null;
  const weightLb = freight.reduce((a, f) => a + (f.weightLb ?? 0), 0) || order.weightLbs || null;
  const commodity = freight.map((f) => f.commodity).filter(Boolean).join(", ") || null;
  const hazmat = order.hazmat || freight.some((f) => f.hazmat);
  const ref = (st: StopRow) => (st ? (st.refs?.reference ?? st.refs?.pickup ?? st.refs?.delivery ?? st.refs?.po ?? null) : null);
  const eq = EQUIPMENT[order.equipment]?.[lang === "es" ? 1 : 0] ?? order.equipment.replace("_", " ");
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className="eyebrow">
          {tenant?.name} · {c.offer}
        </div>
        <Link href={`/t/${token}?lang=${lang === "es" ? "en" : "es"}`} className="text-footnote text-teal font-semibold">
          {c.switchTo}
        </Link>
      </div>
      <div className="h1 mt-1">
        {order.orderNumber} <span className="text-muted font-semibold text-headline">· {c.leg[leg.type] ?? leg.type}</span>
      </div>
      <div className="mt-1">{open ? <Pill tone="teal">{c.openUntil} {fmtWhen(tender.expiresAt, zone)}</Pill> : <Pill tone={tender.state === "accepted" ? "green" : "slate"}>{tender.state === "accepted" ? c.accepted : tender.state === "declined" ? c.declined : tender.state === "expired" ? c.expired : c.withdrawn}</Pill>}</div>

      <div className="card p-5 mt-4 space-y-4">
        <div className="text-title1 font-extrabold tracking-tight">{rate}</div>
        <Stop label={c.pickup} name={fromName} addr={fromAddr} when={fmtWindow(from?.windowStart, from?.windowEnd, fromZone) ?? c.asap} refLabel={c.pickupNo} refValue={ref(from)} notes={from?.notes ?? null} notesLabel={c.instructions} />
        <Stop label={c.delivery} name={toName} addr={toAddr} when={to?.windowStart ? fmtWindow(to.windowStart, to.windowEnd, toZone) : to?.windowEnd ? `${c.by} ${fmtWhen(to.windowEnd, toZone)}` : null} refLabel={c.deliveryNo} refValue={ref(to)} notes={to?.notes ?? null} notesLabel={c.instructions} />
        <div className="grid grid-cols-2 gap-3 text-callout pt-2 border-t border-line" data-testid="tender-details">
          <Fact label={c.equipment} value={eq} />
          <Fact label={c.reference} value={`${order.orderNumber} · ${c.leg_} ${leg.seq}`} mono />
          {commodity && <Fact label={c.commodity} value={commodity} />}
          {pieces != null && <Fact label={c.pieces} value={pieces.toLocaleString("en-US")} />}
          {weightLb != null && <Fact label={c.weight} value={`${weightLb.toLocaleString("en-US")} lb · ${Math.round(weightLb * 0.4536).toLocaleString("en-US")} kg`} />}
          {hazmat && <Fact label={c.hazmat} value="✓" />}
          {order.cargoNote && <Fact label={c.cargo} value={order.cargoNote} wide />}
          {tender.message && <Fact label={c.fromDispatch} value={tender.message} wide />}
        </div>
      </div>

      <div className="card p-5 mt-4">
        {open && tender.counterCents != null && (
          <div className="mb-3 rounded-lg bg-amber-soft text-amber font-semibold px-3 py-2 text-callout" data-testid="counter-pending">
            {c.counterPending(`${tender.currency} ${(tender.counterCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`)}
          </div>
        )}
        {open && tender.counterCents == null && /^counter .* (accepted|declined) by dispatch$/.test(tender.responseNote ?? "") && (
          <div className={`mb-3 rounded-lg px-3 py-2 text-callout font-semibold ${/accepted/.test(tender.responseNote ?? "") ? "bg-green-soft text-green" : "bg-ground text-ink-2"}`} data-testid="counter-answer">
            {/accepted/.test(tender.responseNote ?? "") ? c.counterAccepted : c.counterDeclined}
          </div>
        )}
        {open ? (
          <TenderForm token={token} carrierName={carrier?.name ?? ""} lang={lang} askTrailer={leg.type === "crossing" || leg.type === "mx"} currency={tender.currency} />
        ) : tender.state === "accepted" ? (
          <div>
            <div className="h2">{c.thanks}</div>
            <p className="text-muted mt-1 text-body">{c.acceptedBy(tender.respondedBy ?? "", fmtWhen(tender.respondedAt, zone) ?? "", tender.driverName ?? "", tender.unitNumber, tender.trailerNumber)}</p>
          </div>
        ) : (
          <div>
            <div className="h2">{c.closed}</div>
            <p className="text-muted mt-1 text-body">{tender.state === "expired" ? c.expiredText : tender.state === "declined" ? c.declinedBy(tender.respondedBy ?? "") : c.withdrawnText}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Fact({ label, value, mono, wide }: { label: string; value: string; mono?: boolean; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2" : ""}>
      <div className="text-muted">{label}</div>
      <div className={`font-semibold whitespace-pre-wrap ${mono ? "mono" : ""}`}>{value}</div>
    </div>
  );
}

function Stop({ label, name, addr, when, refLabel, refValue, notes, notesLabel }: { label: string; name: string; addr: string; when: string | null; refLabel: string; refValue: string | null; notes: string | null; notesLabel: string }) {
  return (
    <div className="flex gap-3">
      <div className="w-20 text-caption font-bold text-faint pt-1">{label}</div>
      <div className="min-w-0">
        <div className="font-bold">{name}</div>
        {addr && <div className="text-muted text-callout">{addr}</div>}
        {when && <div className="text-callout font-semibold text-teal">{when}</div>}
        {refValue && (
          <div className="text-callout">
            <span className="text-muted">{refLabel}</span> <span className="mono font-semibold">{refValue}</span>
          </div>
        )}
        {notes && (
          <div className="text-callout">
            <span className="text-muted">{notesLabel}:</span> {notes}
          </div>
        )}
      </div>
    </div>
  );
}
