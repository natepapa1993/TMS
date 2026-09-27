import Link from "next/link";
import { resetTokenUser } from "@/domain/password-reset";
import { ResetForm } from "./form";

export const metadata = { title: "New password" };
export const dynamic = "force-dynamic";

export default async function ResetPage({ params }: PageProps<"/reset/[token]">) {
  const { token } = await params;
  const u = await resetTokenUser(token);
  if (!u)
    return (
      <div className="w-full max-w-sm">
        <div className="h1">This link has expired</div>
        <p className="text-muted mt-1">Reset links work for an hour and once.</p>
        <Link href="/forgot" className="btn btn-primary mt-4">
          Ask for a new one
        </Link>
      </div>
    );
  return (
    <div className="w-full max-w-sm">
      <div className="h1">New password</div>
      <p className="text-muted mt-1 mb-6">
        For <b>{u.email}</b>. At least 10 characters.
      </p>
      <ResetForm token={token} />
    </div>
  );
}
