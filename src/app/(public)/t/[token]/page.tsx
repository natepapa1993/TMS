import { tenderByToken } from "@/domain/tenders";
import { fmtIn } from "@/lib/time";
import { tenantZone } from "@/domain/company";
import { TenderForm } from "./form";
import { Pill } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Load offer" };

const LEG_TYPE_LABEL: Record<string, string> = { mx: "Mexico leg", ca: "Canada leg", crossing: "Border crossing", us: "US leg", domestic: "Domestic", equipment_move: "Equipment move" };

const place = (st: { name: string; address?: { line1?: string; city?: string; state?: string; postalCode?: string } | null } | null) => (st ? [st.name, [st.address?.line1, st.address?.city, [st.address?.state, st.address?.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ")] : ["—", ""]);

export default async function TenderPage({ params }: PageProps<"/t/[token]">) {
  const { token } = await params;
  const t = await tenderByToken(token);
  const zone = t ? await tenantZone(t.tender.tenantId) : "America/Detroit";
  const fmt = (d: Date | null | undefined) => fmtIn(d, zone, { weekday: "short" });
  if (!t || !t.leg || !t.order) {
    return (
      <div className="card p-6 text-center mt-10">
        <div className="h2">This link isn&apos;t valid</div>
        <p className="text-muted mt-1">Ask the dispatcher who sent it for a new one.</p>
      </div>
    );
  }
  const { tender, leg, order, carrier, tenant, from, to } = t;
  const rate = tender.rateCents != null ? `${tender.currency} ${(tender.rateCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "Rate to be confirmed";
  const [fromName, fromAddr] = place(from);
  const [toName, toAddr] = place(to);
  const open = tender.state === "sent";
  return (
    <div>
      <div className="eyebrow">{tenant?.name} · load offer</div>
      <div className="h1 mt-1">
        {order.orderNumber} <span className="text-muted font-semibold text-[16px]">· {LEG_TYPE_LABEL[leg.type] ?? leg.type}</span>
      </div>
      <div className="mt-1">
        {open ? <Pill tone="teal">Open until {fmt(tender.expiresAt)}</Pill> : <Pill tone={tender.state === "accepted" ? "green" : "slate"}>{tender.state === "accepted" ? "Accepted" : tender.state === "declined" ? "Declined" : tender.state === "expired" ? "Expired" : "Withdrawn"}</Pill>}
      </div>

      <div className="card p-5 mt-4 space-y-4">
        <div className="text-[28px] font-extrabold tracking-tight">{rate}</div>
        <Stop label="Pickup" name={fromName} addr={fromAddr} when={fmt(from?.windowStart) ?? "ASAP"} />
        <Stop label="Delivery" name={toName} addr={toAddr} when={to?.windowEnd ? `by ${fmt(to.windowEnd)}` : null} />
        <div className="grid grid-cols-2 gap-3 text-[13px] pt-2 border-t border-line">
          <div>
            <div className="text-muted">Equipment</div>
            <div className="font-semibold capitalize">{order.equipment.replace("_", " ")}</div>
          </div>
          <div>
            <div className="text-muted">Reference</div>
            <div className="font-semibold mono">
              {order.orderNumber} · leg {leg.seq}
            </div>
          </div>
          {order.cargoNote && (
            <div className="col-span-2">
              <div className="text-muted">Cargo</div>
              <div className="font-semibold">{order.cargoNote}</div>
            </div>
          )}
          {tender.message && (
            <div className="col-span-2">
              <div className="text-muted">From dispatch</div>
              <div className="font-semibold whitespace-pre-wrap">{tender.message}</div>
            </div>
          )}
        </div>
      </div>

      <div className="card p-5 mt-4">
        {open ? (
          <TenderForm token={token} carrierName={carrier?.name ?? ""} />
        ) : tender.state === "accepted" ? (
          <div>
            <div className="h2">Thank you — it&apos;s yours.</div>
            <p className="text-muted mt-1 text-[13.5px]">
              Accepted by {tender.respondedBy} on {fmt(tender.respondedAt)}. Driver {tender.driverName}
              {tender.unitNumber ? `, unit ${tender.unitNumber}` : ""}. Dispatch will send pickup details.
            </p>
          </div>
        ) : (
          <div>
            <div className="h2">This offer is closed.</div>
            <p className="text-muted mt-1 text-[13.5px]">{tender.state === "expired" ? "The deadline passed. Call dispatch if you can still cover it." : tender.state === "declined" ? `Declined by ${tender.respondedBy}.` : "Dispatch withdrew it."}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Stop({ label, name, addr, when }: { label: string; name: string; addr: string; when: string | null }) {
  return (
    <div className="flex gap-3">
      <div className="w-16 text-[11px] font-bold tracking-wider uppercase text-faint pt-1">{label}</div>
      <div>
        <div className="font-bold">{name}</div>
        {addr && <div className="text-muted text-[13px]">{addr}</div>}
        {when && <div className="text-[13px] font-semibold text-teal">{when}</div>}
      </div>
    </div>
  );
}
