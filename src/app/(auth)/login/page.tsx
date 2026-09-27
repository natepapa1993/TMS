import Link from "next/link";
import { LoginForm } from "./form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "/dispatch";
  return (
    <div className="w-full max-w-sm">
      <div className="h1">Sign in</div>
      <p className="text-muted mt-1 mb-6">Welcome back.</p>
      <LoginForm next={next} />
      <p className="text-[13px] text-muted mt-6">
        New company?{" "}
        <Link href="/signup" className="font-semibold text-teal">
          Set it up in a minute
        </Link>
      </p>
    </div>
  );
}
