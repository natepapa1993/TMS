import { Mark } from "@/components/mark";

/** Login-free pages: carrier tender, driver app, customer tracking. Phone-first. */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-ground">
      <div className="max-w-[560px] mx-auto px-4 py-5">
        {children}
        <div className="mt-10 flex items-center justify-center gap-1.5 text-footnote text-faint">
          <Mark size={14} /> Crossline
        </div>
      </div>
    </div>
  );
}
