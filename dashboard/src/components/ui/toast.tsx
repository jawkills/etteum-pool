import { useToasts, dismissToast, type ToastTone } from "@/hooks/useToast";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

const toneClass: Record<ToastTone, string> = {
  default: "border-[var(--border)]",
  success: "border-[var(--success)]/40",
  error: "border-[var(--error)]/40",
  warning: "border-[var(--warning)]/40",
};

export function Toaster() {
  const items = useToasts();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2 p-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto rounded-xl border bg-[var(--card)] p-3 shadow-[var(--glow)]",
            toneClass[t.tone]
          )}
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{t.title}</div>
              {t.description ? (
                <div className="mt-0.5 text-xs text-[var(--muted-foreground)]">{t.description}</div>
              ) : null}
            </div>
            <button
              type="button"
              className="rounded-md p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              onClick={() => dismissToast(t.id)}
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
