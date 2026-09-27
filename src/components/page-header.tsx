import type { ReactNode } from "react";

export function PageHeader({ eyebrow, title, actions, children }: { eyebrow?: ReactNode; title: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="px-7 pt-6 pb-4 flex items-end justify-between gap-4 flex-wrap">
      <div>
        {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
        <div className="h1">{title}</div>
        {children && <div className="text-muted mt-1 text-[13.5px]">{children}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
