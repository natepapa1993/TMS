import Link from "next/link";
import { inviteTokenUser } from "@/domain/invites";
import { InviteForm } from "./form";

export const metadata = { title: "Join your team" };
export const dynamic = "force-dynamic";

/** The one-time invite link (owner #22): the person sets their own password. */
export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const u = await inviteTokenUser(token);
  if (!u)
    return (
      <div className="card p-6 mt-10">
        <div className="h1">This invite has expired</div>
        <p className="text-muted mt-1">Invite links work for 7 days and once. Ask the owner to send you a new one.</p>
        <Link href="/login" className="btn btn-primary mt-4">
          Go to sign in
        </Link>
      </div>
    );
  return (
    <div className="card p-6 mt-10">
      <div className="eyebrow">{u.company}</div>
      <div className="h1 mt-1">Welcome, {u.name}</div>
      <p className="text-muted mt-1 mb-6">
        You&apos;re joining as <b>{u.roleLabel}</b>. You sign in with <b>{u.email}</b>. Pick a password of at least 10 characters.
      </p>
      <InviteForm token={token} />
    </div>
  );
}
