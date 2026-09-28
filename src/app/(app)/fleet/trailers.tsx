import Link from "next/link";
import { Pill } from "@/components/ui";

type Row = { id: string; unitNumber: string; kind: string; lengthFt: number | null; usPlate: string | null; status: string; inspectionExpires: string | null; now: { orderId: string; orderNumber: string; legType: string; state: string; route: string } | null; last: { orderNumber: string; where: string | null; at: string | null } | null; idleDays: number | null; loads: number };

const when = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");

export function Trailers({ rows }: { rows: Row[] }) {
  if (!rows.length)
    return (
      <div className="card p-8 text-center">
        <div className="font-bold">No trailers yet</div>
        <div className="text-muted text-callout mt-1">Add one above; the crossing workbench and the assign popup will offer it.</div>
      </div>
    );
  return (
    <div className="card overflow-hidden" data-testid="trailers">
      <table className="table">
        <thead>
          <tr>
            <th>Trailer</th>
            <th>Kind</th>
            <th>Now</th>
            <th>Last seen</th>
            <th>Idle</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <div className="font-bold mono">{r.unitNumber}</div>
                <div className="text-footnote text-muted">{r.usPlate ?? ""}</div>
              </td>
              <td className="text-callout">
                {r.kind.replace("_", " ")}
                {r.lengthFt ? ` · ${r.lengthFt} ft` : ""}
              </td>
              <td>
                {r.now ? (
                  <div>
                    <Link href={`/orders/${r.now.orderId}`} className="font-bold mono hover:text-teal">
                      {r.now.orderNumber}
                    </Link>
                    <span className="text-muted text-callout"> · {r.now.legType} · {r.now.state}</span>
                    <div className="text-footnote text-muted">{r.now.route}</div>
                  </div>
                ) : (
                  <span className="text-muted">free</span>
                )}
              </td>
              <td className="text-callout">
                {r.last ? (
                  <>
                    <div>{r.last.where ?? "—"}</div>
                    <div className="text-muted text-footnote">
                      {r.last.orderNumber} · {when(r.last.at)}
                    </div>
                  </>
                ) : (
                  <span className="text-muted">never on a load</span>
                )}
              </td>
              <td>{r.idleDays != null ? <span className={r.idleDays >= 7 ? "text-red font-bold" : r.idleDays >= 3 ? "text-amber font-semibold" : ""}>{r.idleDays} d</span> : ""}</td>
              <td>
                <Pill tone={r.status === "oos" ? "red" : "green"}>{r.status === "oos" ? "OOS" : "Active"}</Pill>
              </td>
              <td className="text-right">
                <Link href={`/settings/trailers/${r.id}`} className="btn btn-sm btn-ghost">
                  Edit
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
