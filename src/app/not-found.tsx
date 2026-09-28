import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen grid place-items-center">
      <div className="text-center">
        <div className="eyebrow">404</div>
        <div className="h1 mt-1">Not found</div>
        <p className="text-muted mt-2">That record doesn&apos;t exist, or it belongs to another company.</p>
        <Link href="/dispatch" className="btn btn-primary mt-5">
          Back to Dispatch
        </Link>
      </div>
    </div>
  );
}
