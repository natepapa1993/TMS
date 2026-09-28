import Link from "next/link";
import { SignupForm } from "./form";

export const metadata = { title: "Set up your company" };

export default function SignupPage() {
  return (
    <div className="w-full max-w-sm">
      <div className="h1">Set up your company</div>
      <p className="text-muted mt-1 mb-6">You&apos;ll be the owner. Add your team, trucks and customers after.</p>
      <SignupForm />
      <p className="text-callout text-muted mt-6">
        Already set up?{" "}
        <Link href="/login" className="font-semibold text-teal">
          Sign in
        </Link>
      </p>
    </div>
  );
}
