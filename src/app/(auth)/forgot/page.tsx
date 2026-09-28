import Link from "next/link";
import { ForgotForm } from "./form";

export const metadata = { title: "Forgot password" };

export default function ForgotPage() {
  return (
    <div className="w-full max-w-sm">
      <div className="h1">Forgot your password?</div>
      <p className="text-muted mt-1 mb-6">Enter your email and we send a link that sets a new one. It works for an hour.</p>
      <ForgotForm />
      <p className="text-callout text-muted mt-6">
        <Link href="/login" className="font-semibold text-teal">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
