import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { FIELDS, KIND_META, kindByPath } from "@/data/fields";
import { csvTemplate } from "@/data/import";
import { PageHeader } from "@/components/page-header";
import { NoAccess } from "@/components/no-access";
import { can } from "@/lib/context";
import { ImportWizard } from "./wizard";

export default async function ImportPage({ params }: PageProps<"/settings/[kind]/import">) {
  const { kind: path } = await params;
  const kind = kindByPath(path);
  if (!kind) notFound();
  const ctx = await requireCtx();
  if (kind === "user" && !can(ctx, "users.manage")) return <NoAccess area="Managing users" role={ctx.role} />;
  const meta = KIND_META[kind];
  return (
    <div>
      <PageHeader
        eyebrow={
          <span>
            <Link href={`/settings/${path}`} className="hover:text-teal">
              {meta.plural}
            </Link>
          </span>
        }
        title={`Import ${meta.plural.toLowerCase()}`}
      >
        Paste or upload a CSV. We match the columns, show every row with its problems, and only then write.
      </PageHeader>
      <div className="px-gutter pb-10">
        <ImportWizard kind={kind} fields={FIELDS[kind].map((f) => ({ name: f.name, label: f.label, required: !!f.required }))} template={csvTemplate(kind)} listPath={`/settings/${path}`} />
      </div>
    </div>
  );
}
