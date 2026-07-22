import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ eyebrow, title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0 space-y-1">
        {eyebrow ? (
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--primary)]">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="font-heading text-2xl font-bold tracking-tight text-[var(--foreground)] sm:text-[28px]">
          {title}
        </h1>
        {description ? (
          <p className="max-w-2xl text-sm text-[var(--muted-foreground)]">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
