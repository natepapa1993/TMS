"use client";

import Link from "next/link";

/** Anything that throws while rendering an app page lands here instead of a blank Next.js error screen. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="px-7 py-16 max-w-lg">
      <div className="card p-6">
        <div className="eyebrow">Something went wrong</div>
        <div className="font-extrabold text-lg mt-1">This page could not be shown</div>
        <p className="text-muted text-[13.5px] mt-2">Nothing was changed. Try again; if it keeps happening, tell the owner and quote the code below.</p>
        {error.digest && <div className="mono text-[12px] text-faint mt-2">{error.digest}</div>}
        <div className="flex gap-2 mt-4">
          <button className="btn btn-primary" onClick={() => reset()}>
            Try again
          </button>
          <Link href="/dispatch" className="btn">
            Back to Dispatch
          </Link>
        </div>
      </div>
    </div>
  );
}
