import { Mark } from "@/components/mark";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen grid lg:grid-cols-[1.1fr_1fr]">
      <div className="hidden lg:flex flex-col justify-between bg-navy text-white p-12">
        <div className="flex items-center gap-2">
          <Mark />
          <span className="font-extrabold tracking-tight text-lg">Crossline</span>
        </div>
        <div>
          <div className="text-display leading-tight font-extrabold tracking-tight max-w-md">The TMS built for the border.</div>
          <p className="text-slate-300 mt-4 max-w-md text-headline">Mexican leg, crossing, US leg — one order, one screen, every rule enforced before a truck moves.</p>
        </div>
        <div className="text-slate-400 text-xs">Dispatch · Crossing · Compliance · Billing</div>
      </div>
      <div className="flex items-center justify-center p-6">{children}</div>
    </div>
  );
}
