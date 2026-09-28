import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { TripBuilder } from "./builder";

export const metadata = { title: "New trip" };
export const dynamic = "force-dynamic";

export default async function NewTripPage() {
  await requireCtx();
  return (
    <div>
      <PageHeader
        eyebrow={
          <Link href="/trips" className="hover:text-teal">
            Tailgate trips
          </Link>
        }
        title="New trip"
      >
        Stops in driving order. A US yard followed by a Mexican border yard makes the crossing; every run of stops in one country becomes one leg. Shipments come next, on the trip page.
      </PageHeader>
      <div className="px-gutter pb-10 max-w-3xl">
        <TripBuilder />
      </div>
    </div>
  );
}
