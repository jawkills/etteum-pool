import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Status = "live" | "active" | "success" | "warning" | "error" | "idle" | "offline";

const map: Record<
  Status,
  { variant: "success" | "warning" | "error" | "info" | "secondary" | "default" }
> = {
  live: { variant: "success" },
  active: { variant: "success" },
  success: { variant: "success" },
  warning: { variant: "warning" },
  error: { variant: "error" },
  idle: { variant: "secondary" },
  offline: { variant: "error" },
};

export function StatusBadge({
  status,
  children,
  className,
  pulse,
}: {
  status: Status;
  children?: ReactNode;
  className?: string;
  pulse?: boolean;
}) {
  const m = map[status];
  return (
    <Badge variant={m.variant} className={cn("gap-1.5", className)}>
      {pulse ? (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      ) : null}
      {children ?? status}
    </Badge>
  );
}
