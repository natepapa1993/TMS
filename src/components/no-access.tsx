import Link from "next/link";

/** Shown in place of a page the signed-in role cannot see. The owner grants roles under Settings → Users. */
export function NoAccess({ area, role }: { area: string; role: string }) {
  return (
    <div className="px-gutter py-16 max-w-lg">
      <div className="card p-6">
        <div className="eyebrow">No access</div>
        <div className="font-extrabold text-lg mt-1">{area} is not part of your role</div>
        <p className="text-muted text-body mt-2">
          You are signed in as <b>{role}</b>. The owner can change roles under Settings → Users.
        </p>
        <div className="flex gap-2 mt-4">
          <Link href="/dispatch" className="btn btn-primary">
            Back to Dispatch
          </Link>
          <Link href="/orders" className="btn">
            Orders
          </Link>
        </div>
      </div>
    </div>
  );
}
