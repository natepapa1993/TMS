import { requireCtx } from "@/lib/auth";
import { assetMap } from "@/domain/asset-map";
import { MapScreen } from "./map-screen";

export const metadata = { title: "Map" };
export const dynamic = "force-dynamic";

export default async function MapPage() {
  const ctx = await requireCtx();
  const data = await assetMap(ctx);
  return <MapScreen data={data} />;
}
