import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { can } from "@/lib/context";
import { myAccount, ROLE_LABEL } from "@/domain/users";
import { PageHeader } from "@/components/page-header";
import { AccountForm } from "./form";

export const metadata = { title: "My account" };
export const dynamic = "force-dynamic";

/** Everyone's own name, phone and password. Role and sign-in email are the owner's to change. */
export default async function AccountPage() {
  const ctx = await requireCtx();
  const me = await myAccount(ctx);
  const owner = can(ctx, "users.manage");
  return (
    <div>
      <PageHeader
        eyebrow={
          <Link href="/settings" className="hover:text-teal">
            Settings
          </Link>
        }
        title="My account"
      >
        Your name, phone and password.
      </PageHeader>
      <div className="px-gutter pb-10 max-w-2xl space-y-4">
        <div className="card p-5">
          <div className="grid grid-cols-2 gap-3 text-callout mb-4">
            <div>
              <div className="label">Sign-in email</div>
              <div className="font-semibold" data-testid="my-email">{me.email}</div>
            </div>
            <div>
              <div className="label">Role</div>
              <div className="font-semibold" data-testid="my-role">{ROLE_LABEL[me.role] ?? me.role}</div>
            </div>
          </div>
          <div className="help mb-4">{owner ? "Change roles and emails under Settings → Users." : "Only the owner changes roles and sign-in emails. Ask them if yours is wrong."}</div>
          <AccountForm initial={{ name: me.name, phone: me.phone ?? "" }} />
        </div>
      </div>
    </div>
  );
}
