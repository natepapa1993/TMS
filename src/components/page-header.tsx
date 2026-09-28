import type { ReactNode } from "react";

/** The top of every page: breadcrumb or eyebrow, a big title, a short subtitle, and the actions on the right (one primary). */
export function PageHeader({ eyebrow, title, actions, children }: { eyebrow?: ReactNode; title: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-header">
      <div className="min-w-0 flex-1">
        {eyebrow && <div className="eyebrow mb-1.5">{eyebrow}</div>}
        <h1 className="h1">{title}</h1>
        {children && <div className="subtitle">{children}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
