import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--border)] bg-[var(--card)]/50 px-6 py-16 text-center",
        className
      )}
    >
      {icon ? <div className="mb-4 text-[var(--primary)] opacity-80">{icon}</div> : null}
      <h3 className="font-heading text-lg font-semibold">{title}</h3>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-[var(--muted-foreground)]">{description}</p>
      ) : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}
