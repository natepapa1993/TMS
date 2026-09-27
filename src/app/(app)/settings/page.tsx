import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { counts, type RecordKind } from "@/data/records";
import { KIND_META } from "@/data/fields";
import { PageHeader } from "@/components/page-header";

export const metadata = { title: "Settings" };

const SECTIONS: ("Company" | "Fleet" | "Partners" | "Rules")[] = ["Company", "Fleet", "Partners", "Rules"];

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const c = await counts(ctx);
  const kinds = Object.keys(KIND_META) as RecordKind[];
  const setupSteps: { kind: RecordKind; why: string }[] = [
    { kind: "billingEntity", why: "so invoices carry the right name and prefix" },
    { kind: "truck", why: "unit numbers and plates" },
    { kind: "driver", why: "B-1, CDL or dual — the rules depend on it" },
    { kind: "customer", why: "who you bill" },
    { kind: "location", why: "your yards and the border yard" },
  ];
  const todo = setupSteps.filter((s) => !c[s.kind]);
  return (
    <div>
      <PageHeader eyebrow="Setup" title={sp.welcome ? `Welcome, ${ctx.name.split(" ")[0]}` : "Settings"}>
        Everything here is yours to add, edit and archive. Nothing is hard-coded.
      </PageHeader>
      <div className="px-7 pb-10 space-y-8">
        {todo.length > 0 && (
          <div className="card p-5">
            <div className="h2">Day one</div>
            <p className="text-muted text-[13px] mt-0.5 mb-3">Five things and you can dispatch. Each takes a minute; import a CSV if you have one.</p>
            <ol className="space-y-2">
              {setupSteps.map((s, i) => {
                const done = c[s.kind] > 0;
                return (
                  <li key={s.kind} className="flex items-center gap-3 text-[13.5px]">
                    <span className={`w-6 h-6 rounded-full grid place-items-center text-[12px] font-extrabold ${done ? "bg-teal text-white" : "bg-line text-muted"}`}>{done ? "✓" : i + 1}</span>
                    <Link href={`/settings/${KIND_META[s.kind].path}${done ? "" : "?add=1"}`} className={`font-bold ${done ? "text-muted line-through" : "text-teal"}`}>
                      Add {KIND_META[s.kind].plural.toLowerCase()}
                    </Link>
                    <span className="text-muted">— {s.why}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        <section>
          <div className="eyebrow mb-2">Connections</div>
          <Link href="/settings/integrations" className="card p-4 hover:border-teal transition-colors flex items-start justify-between gap-3 max-w-md">
            <div>
              <div className="font-extrabold">Integrations</div>
              <div className="text-muted text-[12.5px] mt-0.5">Motive ELD tracking, email sending</div>
            </div>
          </Link>
        </section>
        {SECTIONS.map((sec) => (
          <section key={sec}>
            <div className="eyebrow mb-2">{sec}</div>
            <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
              {kinds
                .filter((k) => KIND_META[k].section === sec)
                .map((k) => (
                  <Link key={k} href={`/settings/${KIND_META[k].path}`} className="card p-4 hover:border-teal transition-colors flex items-start justify-between gap-3">
                    <div>
                      <div className="font-extrabold">{KIND_META[k].plural}</div>
                      <div className="text-muted text-[12.5px] mt-0.5">{KIND_META[k].blurb}</div>
                    </div>
                    <span className="count">{c[k]}</span>
                  </Link>
                ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
