import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { get, history, archiveBlockers } from "@/data/records";
import { FIELDS, KIND_META, kindByPath, fieldsFor } from "@/data/fields";
import { can } from "@/lib/context";
import { loadRefs } from "@/data/refs";
import { PageHeader } from "@/components/page-header";
import { RecordEditor } from "./editor";
import { SubjectDocuments } from "./documents";
import { statusFor, subjectDocuments, type SubjectKind } from "@/domain/compliance";
import { list } from "@/data/records";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { publicUrl, issueToken } from "@/lib/tokens";
import { ediLog } from "@/domain/edi";
import { carrierPortalLink, scorecard } from "@/domain/carrier-portal";
import { CarrierPortalCard } from "./carrier-portal-card";
import { DriverAppCard } from "./driver-app-card";
import { customerPortalLink } from "@/domain/customer-portal";
import { CustomerPortalCard } from "./customer-portal-card";
import { MailboxCard } from "./mailbox-card";
import { publicMailbox } from "@/domain/edi-mailbox";
import type { EdiMailbox } from "@/db/schema";

export default async function RecordPage({ params }: PageProps<"/settings/[kind]/[id]">) {
  const { kind: path, id } = await params;
  const kind = kindByPath(path);
  if (!kind) notFound();
  const ctx = await requireCtx();
  const row = await get(ctx, kind, id).catch(() => null);
  if (!row) notFound();
  const meta = KIND_META[kind];
  const [{ options }, hist, blockers, people] = await Promise.all([loadRefs(ctx, kind), history(ctx, kind, id), archiveBlockers(ctx, kind, id), db.select({ id: users.id, name: users.name }).from(users).where(eq(users.tenantId, ctx.tenantId))]);
  const who = new Map(people.map((p) => [p.id, p.name]));
  const isSubject = ["driver", "truck", "trailer", "carrier"].includes(kind);
  const [docs, compliance, types] = isSubject
    ? await Promise.all([subjectDocuments(ctx, kind as SubjectKind, id), statusFor(ctx, kind as SubjectKind, id).catch(() => null), list(ctx, "documentType", { limit: 200 })])
    : [[], null, []];
  const partnerLog = kind === "ediPartner" ? await ediLog(ctx, { partnerId: id, limit: 8 }) : [];
  const [portal, score] = kind === "carrier" ? await Promise.all([carrierPortalLink(ctx, id), scorecard(ctx, id)]) : [null, null];
  const customerPortal = kind === "customer" ? await customerPortalLink(ctx, id) : null;
  const driverApp = kind === "driver" ? publicUrl(`/d/${(await issueToken(ctx, "driver_app", id, { label: String(row.name) })).token}`) : null;
  const labelField = FIELDS[kind][0].name;
  const title = String(row[labelField] ?? meta.singular);
  return (
    <div>
      <PageHeader
        eyebrow={
          <span>
            <Link href="/settings" className="hover:text-teal">
              Settings
            </Link>
            {" · "}
            <Link href={`/settings/${path}`} className="hover:text-teal">
              {meta.plural}
            </Link>
          </span>
        }
        title={
          <span className="flex items-center gap-3">
            {title}
            {row.archivedAt && <span className="pill pill-slate">Archived</span>}
            {kind === "truck" && row.status === "oos" && <span className="pill pill-red">Out of service</span>}
          </span>
        }
      />
      <div className="px-gutter pb-10 grid lg:grid-cols-[1fr_320px] gap-5 items-start [&>*]:min-w-0">
        <div className="card p-5">
          <RecordEditor
            kind={kind}
            id={id}
            fields={fieldsFor(kind, can(ctx, "compliance.edit"))}
            refs={options}
            initial={JSON.parse(JSON.stringify(row))}
            archived={!!row.archivedAt}
            blockers={blockers.map((b) => b.label)}
            listPath={`/settings/${path}`}
          />
        </div>
        <aside className="space-y-4">
          {isSubject && (
            <SubjectDocuments
              kind={kind as SubjectKind}
              subjectId={id}
              docs={JSON.parse(JSON.stringify(docs))}
              types={types.filter((x) => x.appliesTo === kind).map((x) => ({ id: x.id, name: String(x.name), tracksExpiry: !!x.tracksExpiry, required: !!x.required, blocksDispatch: !!x.blocksDispatch }))}
              status={compliance ? JSON.parse(JSON.stringify({ dispatchable: compliance.dispatchable, items: compliance.items, override: compliance.override })) : null}
              canEdit={["owner", "compliance", "dispatcher", "mx_office"].includes(ctx.role)}
            />
          )}
          {kind === "driver" && compliance && (() => {
            const dq = compliance.items.filter((i) => i.key.startsWith("dq:"));
            const gaps = dq.filter((i) => i.status === "missing" || i.status === "expired" || (i.status === "snoozed" && (i.underlying === "missing" || i.underlying === "expired"))).length;
            const hold = compliance.items.some((i) => i.key === "da:status" && i.status === "expired");
            return (
              <div className="card p-4" data-testid="safety-file-card">
                <div className="eyebrow mb-2">Safety file</div>
                <div className="text-callout">
                  Qualification file: {gaps ? <span className="pill pill-amber">{gaps} missing or overdue</span> : <span className="pill pill-green">complete</span>}
                  {hold && <span className="pill pill-red ml-1">safety hold</span>}
                </div>
                <Link href={`/compliance/drivers/${id}`} className="btn btn-sm mt-3">
                  Open safety file
                </Link>
              </div>
            );
          })()}
          {kind === "driver" && driverApp && <DriverAppCard driverId={id} url={driverApp} whatsapp={(row.whatsapp as string | null) ?? null} phone={(row.phone as string | null) ?? null} canEdit={["owner", "dispatcher", "compliance"].includes(ctx.role)} />}
          {kind === "customer" && customerPortal && <CustomerPortalCard customerId={id} url={customerPortal.url} email={customerPortal.email} canEdit={["owner", "dispatcher", "billing"].includes(ctx.role)} />}
          {kind === "carrier" && portal && score && <CarrierPortalCard carrierId={id} url={portal.url} whatsapp={portal.whatsapp} email={portal.email} score={score} canEdit={["owner", "dispatcher"].includes(ctx.role)} />}
          {kind === "ediPartner" && <MailboxCard partnerId={id} mailbox={publicMailbox(row.mailbox as EdiMailbox | null)} delivery={String(row.delivery)} canEdit={ctx.role === "owner"} />}
          {kind === "ediPartner" && (
            <div className="card p-4">
              <div className="eyebrow mb-2">Inbound URL</div>
              <div className="text-footnote mono break-all select-all bg-ground rounded p-2 border border-line">{publicUrl(`/api/edi/inbound/${String(row.inboundToken)}`)}</div>
              <div className="help mt-1">The partner (or their VAN / AS2 gateway) POSTs X12 here; the 997 comes back in the response. Their ISA sender must be {String(row.theirId)}.</div>
              <div className="eyebrow mt-4 mb-2">Recent messages</div>
              {partnerLog.length === 0 ? (
                <div className="text-muted text-callout">Nothing yet.</div>
              ) : (
                <ul className="space-y-1 text-callout">
                  {partnerLog.map((l) => (
                    <li key={l.m.id} className="flex justify-between gap-2">
                      <span className="truncate">
                        <b className="mono">{l.m.type}</b> {l.m.direction === "in" ? "⇦" : "⇨"} {l.m.summary}
                      </span>
                      <span className={`pill ${l.m.state === "error" ? "pill-red" : "pill-slate"}`}>{l.m.state}</span>
                    </li>
                  ))}
                </ul>
              )}
              <Link href="/edi" className="btn btn-sm mt-3">
                Open EDI inbox & log
              </Link>
            </div>
          )}
          {kind === "truck" && (
            <div className="card p-4">
              <div className="eyebrow mb-2">Status</div>
              {row.status === "oos" ? (
                <div className="text-callout">
                  <span className="pill pill-red">OOS</span> <span className="ml-1">{String(row.oosReason ?? "")}</span>
                  {row.oosUntil ? <div className="text-muted mt-1">Until {new Date(row.oosUntil as string).toLocaleDateString()}</div> : null}
                </div>
              ) : (
                <div className="text-callout">
                  <span className="pill pill-green">Active</span>
                </div>
              )}
              <div className="help mt-2">Put a unit out of service from the Fleet page; planned loads go back to Pending automatically.</div>
            </div>
          )}
          <div className="card p-4">
            <div className="eyebrow mb-2">History</div>
            {hist.length === 0 ? (
              <div className="text-muted text-callout">No changes yet.</div>
            ) : (
              <ul className="space-y-2.5">
                {hist.slice(0, 30).map((h) => (
                  <li key={h.id} className="text-callout">
                    <div className="flex justify-between gap-2">
                      <span className="font-bold capitalize">{h.action}</span>
                      <span className="text-faint whitespace-nowrap">{new Date(h.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                    </div>
                    <div className="text-muted">{h.userId ? (who.get(h.userId) ?? "someone") : "system"}</div>
                    {h.changes && (
                      <div className="text-muted mt-0.5">
                        {Object.entries(h.changes)
                          .slice(0, 6)
                          .map(([k, c]) => `${k}: ${fmt(c.from)} → ${fmt(c.to)}`)
                          .join(" · ")}
                      </div>
                    )}
                    {h.note && <div className="text-muted italic">{h.note}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function fmt(v: unknown) {
  if (v == null || v === "") return "—";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 10);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
