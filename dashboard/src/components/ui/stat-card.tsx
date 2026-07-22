import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface StatCardProps {
  label: string;
  value: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  emphasize?: boolean;
  className?: string;
}

export function StatCard({ label, value, subtitle, icon, emphasize, className }: StatCardProps) {
  return (
    <Card className={cn(emphasize && "border-[var(--primary)]/40", className)}>
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--muted-foreground)]">
              {label}
            </div>
            <div className="mt-1 font-mono text-2xl font-semibold tracking-tight sm:text-[28px]">
              {value}
            </div>
            {subtitle ? (
              <div className="mt-1 text-xs text-[var(--muted-foreground)]">{subtitle}</div>
            ) : null}
          </div>
          {icon ? (
            <div className="rounded-lg border border-[var(--primary)]/40 bg-[var(--primary)]/15 p-2 text-[var(--primary)]">
              {icon}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
