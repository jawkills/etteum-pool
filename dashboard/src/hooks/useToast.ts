import { useSyncExternalStore } from "react";

export type ToastTone = "default" | "success" | "error" | "warning";

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
}

type Listener = () => void;

let toasts: ToastItem[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export function toast(input: {
  title: string;
  description?: string;
  tone?: ToastTone;
  durationMs?: number;
}) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const item: ToastItem = {
    id,
    title: input.title,
    description: input.description,
    tone: input.tone ?? "default",
  };
  toasts = [...toasts, item];
  emit();
  const duration = input.durationMs ?? 3500;
  window.setTimeout(() => dismissToast(id), duration);
  return id;
}

export function dismissToast(id: string) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => toasts,
    () => toasts
  );
}
