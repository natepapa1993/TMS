import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { ImportLoads } from "./import";

export const metadata = { title: "Import loads" };

export default async function ImportPage() {
  await requireCtx();
  return (
    <div className="px-5 md:px-8 pt-6 pb-10 max-w-6xl">
      <div className="eyebrow mb-1">
        <Link href="/orders" className="hover:text-teal">
          Loads
        </Link>{" "}
        / Import
      </div>
      <h1 className="text-[24px] font-extrabold tracking-tight">Import loads</h1>
      <div className="text-muted text-[13px] mt-0.5 mb-6">An Excel (.xlsx) or CSV sheet: one row per load with pickup and delivery columns, or one row per stop with a Load column to group them. You see every load and what is wrong with it before anything is created.</div>
      <ImportLoads />
    </div>
  );
}
