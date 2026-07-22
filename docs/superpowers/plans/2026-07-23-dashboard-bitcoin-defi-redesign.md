# Dashboard Bitcoin DeFi Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the entire Etteum Pool dashboard (`dashboard/`) from neon-green VS Code chrome into a dark-first Bitcoin DeFi aesthetic (void surfaces, orange/gold energy, technical typography, shared UI patterns) without changing routes or APIs.

**Architecture:** Design-system first. Rewrite CSS tokens in `dashboard/src/index.css`, upgrade `components/ui/*` + add shared layout patterns (`PageHeader`, `EmptyState`, `StatCard`, toast, `ConfirmDialog`), restyle shell (`Layout`, `Sidebar`, `Login`), then sweep every page to consume the kit. No backend changes.

**Tech Stack:** React 19, Vite 8, Tailwind CSS 4 (`@theme inline`), Radix primitives, CVA, Lucide, Recharts, react-router 7, Bun (build via `cd dashboard && bun run build`).

**Spec:** `docs/superpowers/specs/2026-07-23-dashboard-bitcoin-defi-redesign.md`

---

## File map

| Path | Action | Responsibility |
|------|--------|----------------|
| `dashboard/index.html` | Modify | Fonts preconnect/link; theme-color meta void/orange light fallback |
| `dashboard/src/index.css` | Modify | Bitcoin DeFi tokens (dark + light), glow utilities, font helpers, grid helper, scrollbar |
| `dashboard/src/hooks/useTheme.tsx` | Modify | theme-color meta values for void / light fallback |
| `dashboard/src/components/ui/button.tsx` | Modify | Pill, gradient primary + glow, outline/ghost |
| `dashboard/src/components/ui/card.tsx` | Modify | rounded-2xl, white/10 border, hover glow optional |
| `dashboard/src/components/ui/input.tsx` | Modify | Terminal/minimal focus orange |
| `dashboard/src/components/ui/textarea.tsx` | Modify | Match input |
| `dashboard/src/components/ui/badge.tsx` | Modify | Mono status variants; gold/orange discipline |
| `dashboard/src/components/ui/alert.tsx` | Modify | Void-surface alert tones |
| `dashboard/src/components/ui/dialog.tsx` | Modify | Glass/void dialog chrome |
| `dashboard/src/components/ui/tabs.tsx` | Modify | Active orange underline/pill |
| `dashboard/src/components/ui/select.tsx` | Modify | Match input/border tokens |
| `dashboard/src/components/ui/progress.tsx` | Modify | Orange track fill |
| `dashboard/src/components/ui/tooltip.tsx` | Modify | Void popover surface |
| `dashboard/src/components/ui/page-header.tsx` | Create | Shared page header |
| `dashboard/src/components/ui/empty-state.tsx` | Create | Shared empty state |
| `dashboard/src/components/ui/stat-card.tsx` | Create | KPI card |
| `dashboard/src/components/ui/status-badge.tsx` | Create | Live/error/idle pills (mono) |
| `dashboard/src/components/ui/confirm-dialog.tsx` | Create | Destructive confirm wrapper |
| `dashboard/src/components/ui/toast.tsx` | Create | Minimal toast store + viewport |
| `dashboard/src/hooks/useToast.ts` | Create | `toast()` API used by pages |
| `dashboard/src/main.tsx` | Modify | Mount `<Toaster />` |
| `dashboard/src/components/layout/Layout.tsx` | Modify | Void main chrome, mobile menu button |
| `dashboard/src/components/layout/Sidebar.tsx` | Modify | Gradient active pill, mono labels, gold WS live |
| `dashboard/src/pages/Login.tsx` | Modify | Void + grid + gradient CTA |
| `dashboard/src/components/dashboard/StatsCards.tsx` | Modify | Use StatCard / mono values / orange-gold |
| `dashboard/src/components/dashboard/*` | Modify | Chart colors + card chrome as needed |
| `dashboard/src/pages/*.tsx` | Modify | PageHeader, badges, toasts, remove neon one-offs |
| `dashboard/src/components/integration/*`, `vcc/*` | Modify | Match kit |

**Do not:** change `src/` backend, API paths, WS event names, or add paid UI kits.

**Verify command (most tasks):**

```bash
cd dashboard && bun run build
```

Expected: TypeScript + Vite build succeed (exit 0).

---

### Task 1: Design tokens + fonts

**Files:**
- Modify: `dashboard/index.html`
- Modify: `dashboard/src/index.css`
- Modify: `dashboard/src/hooks/useTheme.tsx`

- [ ] **Step 1: Load fonts in `dashboard/index.html`**

Add inside `<head>` (before title is fine):

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;600;700&display=swap"
  rel="stylesheet"
/>
```

Update theme-color metas to void / light fallback:

```html
<meta name="theme-color" content="#030304" media="(prefers-color-scheme: dark)" />
<meta name="theme-color" content="#f4f4f5" media="(prefers-color-scheme: light)" />
```

In the no-flash script, when light is applied, set meta content to `#f4f4f5` (replace `#f3f7f4`).

- [ ] **Step 2: Replace `:root` and `.light` tokens in `dashboard/src/index.css`**

Replace the existing `:root { ... }` and `.light { ... }` blocks with:

```css
:root {
  /* Surfaces — true void */
  --background: #030304;
  --foreground: #ffffff;
  --card: #0f1115;
  --card-foreground: #ffffff;
  --popover: #0f1115;
  --popover-foreground: #ffffff;

  /* Brand — Bitcoin orange */
  --primary: #f7931a;
  --primary-foreground: #ffffff;
  --primary-deep: #ea580c;
  --gold: #ffd600;
  --accent: #f7931a;
  --accent-foreground: #ffffff;

  /* Neutrals */
  --secondary: #151922;
  --secondary-foreground: #cbd5e1;
  --muted: #151922;
  --muted-foreground: #94a3b8;

  /* Semantic */
  --success: #ffd600;
  --success-foreground: #1a1400;
  --warning: #fbbf24;
  --warning-foreground: #1a1200;
  --error: #f87171;
  --error-foreground: #1a0606;
  --info: #94a3b8;
  --info-foreground: #030304;
  --destructive: #ef4444;
  --destructive-foreground: #ffffff;

  /* Lines & focus */
  --border: rgba(255, 255, 255, 0.1);
  --input: rgba(255, 255, 255, 0.1);
  --ring: #f7931a;

  /* Sidebar */
  --sidebar-bg: #030304;
  --sidebar-border: rgba(255, 255, 255, 0.08);

  /* Charts — orange/gold first, restrained extras */
  --chart-1: #f7931a;
  --chart-2: #ffd600;
  --chart-3: #ea580c;
  --chart-4: #fb923c;
  --chart-5: #fbbf24;
  --chart-6: #94a3b8;

  /* Effects */
  --glow: 0 0 20px -5px rgba(234, 88, 12, 0.5);
  --glow-strong: 0 0 30px -5px rgba(247, 147, 26, 0.6);
  --glow-gold: 0 0 16px rgba(255, 214, 0, 0.35);
  --shadow-card: 0 0 40px -12px rgba(247, 147, 26, 0.12);
  --gradient-primary: linear-gradient(90deg, #ea580c, #f7931a);
  --gradient-gold-text: linear-gradient(90deg, #f7931a, #ffd600);

  --radius: 0.75rem;

  --font-heading: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
  --font-body: "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
}

.light {
  --background: #f4f4f5;
  --foreground: #09090b;
  --card: #ffffff;
  --card-foreground: #09090b;
  --popover: #ffffff;
  --popover-foreground: #09090b;

  --primary: #c2410c;
  --primary-foreground: #ffffff;
  --primary-deep: #9a3412;
  --gold: #ca8a04;
  --accent: #c2410c;
  --accent-foreground: #ffffff;

  --secondary: #e4e4e7;
  --secondary-foreground: #27272a;
  --muted: #f4f4f5;
  --muted-foreground: #71717a;

  --success: #a16207;
  --success-foreground: #ffffff;
  --warning: #b45309;
  --warning-foreground: #ffffff;
  --error: #dc2626;
  --error-foreground: #ffffff;
  --info: #475569;
  --info-foreground: #ffffff;
  --destructive: #dc2626;
  --destructive-foreground: #ffffff;

  --border: #e4e4e7;
  --input: #e4e4e7;
  --ring: #c2410c;

  --sidebar-bg: #ffffff;
  --sidebar-border: #e4e4e7;

  --chart-1: #c2410c;
  --chart-2: #ca8a04;
  --chart-3: #ea580c;
  --chart-4: #f97316;
  --chart-5: #d97706;
  --chart-6: #64748b;

  --glow: 0 1px 2px rgba(0, 0, 0, 0.06);
  --glow-strong: 0 4px 12px rgba(194, 65, 12, 0.2);
  --glow-gold: 0 2px 8px rgba(202, 138, 4, 0.2);
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.04), 0 4px 12px rgba(0, 0, 0, 0.04);
  --gradient-primary: linear-gradient(90deg, #9a3412, #c2410c);
  --gradient-gold-text: linear-gradient(90deg, #c2410c, #ca8a04);
}
```

Keep the existing `@theme inline { ... }` block (it already maps semantic names). Ensure body uses Inter:

```css
body {
  background-color: var(--background);
  color: var(--foreground);
  font-family: var(--font-body);
  margin: 0;
  padding: 0;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
```

Replace `.glow` utility and add helpers after it:

```css
.glow {
  box-shadow: var(--glow);
}

.glow-strong {
  box-shadow: var(--glow-strong);
}

.font-heading {
  font-family: var(--font-heading);
}

.font-mono {
  font-family: var(--font-mono);
}

.text-gradient-gold {
  background-image: var(--gradient-gold-text);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.bg-gradient-primary {
  background-image: var(--gradient-primary);
}

.bg-grid-pattern {
  background-size: 48px 48px;
  background-image:
    linear-gradient(to right, rgba(30, 41, 59, 0.45) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(30, 41, 59, 0.45) 1px, transparent 1px);
  mask-image: radial-gradient(circle at center, black 35%, transparent 100%);
}

@media (prefers-reduced-motion: reduce) {
  .animate-ping,
  .theme-transition,
  .theme-transition * {
    animation: none !important;
    transition: none !important;
  }
}
```

- [ ] **Step 3: Update theme-color in `useTheme.tsx`**

In `applyTheme`, change:

```ts
meta.setAttribute("content", theme === "light" ? "#f4f4f5" : "#030304");
```

- [ ] **Step 4: Build**

```bash
cd dashboard && bun run build
```

Expected: success.

- [ ] **Step 5: Commit**

```bash
git add dashboard/index.html dashboard/src/index.css dashboard/src/hooks/useTheme.tsx
git commit -m "feat(dashboard): Bitcoin DeFi design tokens and fonts"
```

---

### Task 2: Core UI primitives (Button, Card, Input, Badge)

**Files:**
- Modify: `dashboard/src/components/ui/button.tsx`
- Modify: `dashboard/src/components/ui/card.tsx`
- Modify: `dashboard/src/components/ui/input.tsx`
- Modify: `dashboard/src/components/ui/textarea.tsx`
- Modify: `dashboard/src/components/ui/badge.tsx`

- [ ] **Step 1: Restyle Button**

Replace `buttonVariants` in `button.tsx` with:

```tsx
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
  {
    variants: {
      variant: {
        default:
          "bg-gradient-primary text-[var(--primary-foreground)] shadow-[var(--glow)] hover:shadow-[var(--glow-strong)] hover:scale-[1.02] active:scale-[0.99]",
        destructive:
          "bg-[var(--destructive)] text-[var(--destructive-foreground)] hover:bg-[var(--destructive)]/90",
        outline:
          "border-2 border-white/20 bg-transparent text-[var(--foreground)] hover:border-white/50 hover:bg-white/5 light:border-[var(--border)] light:hover:bg-[var(--secondary)]",
        secondary:
          "bg-[var(--secondary)] text-[var(--secondary-foreground)] hover:bg-[var(--secondary)]/80",
        ghost:
          "hover:bg-white/10 text-[var(--foreground)] hover:text-[var(--primary)]",
        link: "text-[var(--primary)] underline-offset-4 hover:underline rounded-none",
      },
      size: {
        default: "h-10 px-5 py-2 min-h-[44px] md:min-h-0",
        sm: "h-8 px-3 text-xs min-h-[44px] md:min-h-0",
        lg: "h-11 px-8 min-h-[44px] md:min-h-0",
        icon: "h-10 w-10 min-h-[44px] md:min-h-0 min-w-[44px] md:min-w-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);
```

Note: if `light:` variant utilities are unreliable under Tailwind 4, drop `light:` classes and rely on CSS variables for outline borders (`border-[var(--border)]` instead of `border-white/20`). Prefer variable-based borders for dual theme:

```tsx
outline:
  "border-2 border-[var(--border)] bg-transparent text-[var(--foreground)] hover:border-[var(--primary)]/50 hover:bg-[var(--secondary)]",
```

- [ ] **Step 2: Restyle Card**

```tsx
// Card root className
"rounded-2xl border border-[var(--border)] bg-[var(--card)] text-[var(--card-foreground)] shadow-[var(--shadow-card)] transition-all duration-300"
```

Optional hover for interactive cards is applied by consumers (`hover:border-[var(--primary)]/50 hover:-translate-y-0.5`), not forced on every Card.

Use `font-heading` on `CardTitle`:

```tsx
"font-heading font-semibold leading-none tracking-tight"
```

- [ ] **Step 3: Restyle Input + Textarea**

Input classes:

```tsx
"flex h-11 w-full rounded-lg border border-[var(--border)] bg-black/50 px-3 py-2 text-sm text-[var(--foreground)] transition-all duration-200 placeholder:text-[var(--muted-foreground)]/50 focus-visible:outline-none focus-visible:border-[var(--primary)] focus-visible:ring-0 focus-visible:shadow-[0_10px_20px_-10px_rgba(247,147,26,0.3)] disabled:cursor-not-allowed disabled:opacity-50 font-[family-name:var(--font-body)]"
```

For light mode readability, prefer `bg-[var(--background)]` if `bg-black/50` looks wrong in light — use:

```tsx
"… bg-[color-mix(in_srgb,var(--background)_70%,black)] …"
```

or simply `bg-[var(--background)]` with stronger border focus (acceptable dual-theme compromise).

Mirror the same focus treatment on `textarea.tsx`.

- [ ] **Step 4: Restyle Badge**

Keep variants; ensure mono for status:

```tsx
const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-medium font-mono uppercase tracking-wider transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:ring-offset-2 focus:ring-offset-[var(--background)]",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[var(--primary)] text-[var(--primary-foreground)]",
        secondary: "border-transparent bg-[var(--secondary)] text-[var(--secondary-foreground)]",
        destructive: "border-transparent bg-[var(--destructive)] text-[var(--destructive-foreground)]",
        outline: "border-[var(--border)] text-[var(--foreground)]",
        success: "border-[var(--success)]/35 bg-[var(--success)]/12 text-[var(--success)]",
        warning: "border-[var(--warning)]/35 bg-[var(--warning)]/12 text-[var(--warning)]",
        error: "border-[var(--error)]/35 bg-[var(--error)]/12 text-[var(--error)]",
        info: "border-[var(--info)]/35 bg-[var(--info)]/12 text-[var(--info)]",
      },
    },
    defaultVariants: { variant: "default" },
  }
);
```

- [ ] **Step 5: Build + commit**

```bash
cd dashboard && bun run build
git add dashboard/src/components/ui/button.tsx dashboard/src/components/ui/card.tsx dashboard/src/components/ui/input.tsx dashboard/src/components/ui/textarea.tsx dashboard/src/components/ui/badge.tsx
git commit -m "feat(dashboard): restyle core UI primitives for Bitcoin DeFi"
```

---

### Task 3: Remaining ui/* chrome (Dialog, Tabs, Select, Alert, Progress, Tooltip)

**Files:**
- Modify: `dashboard/src/components/ui/dialog.tsx`
- Modify: `dashboard/src/components/ui/tabs.tsx`
- Modify: `dashboard/src/components/ui/select.tsx`
- Modify: `dashboard/src/components/ui/alert.tsx`
- Modify: `dashboard/src/components/ui/progress.tsx`
- Modify: `dashboard/src/components/ui/tooltip.tsx`

- [ ] **Step 1: Dialog**

Overlay: `bg-black/70 backdrop-blur-sm`  
Content: `rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-[var(--glow)]`  
Title: `font-heading`

- [ ] **Step 2: Tabs**

Active trigger: `text-[var(--primary)] border-b-2 border-[var(--primary)]` or pill `bg-[var(--primary)]/15 text-[var(--primary)]` — pick one style and use consistently. Prefer pill for DeFi feel:

```tsx
// active
"bg-[var(--primary)]/15 text-[var(--primary)] shadow-[var(--glow)]"
// inactive
"text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
```

- [ ] **Step 3: Select / Alert / Progress / Tooltip**

- Select trigger: match Input border/focus  
- Alert: `rounded-xl border` + tone backgrounds using `/10` of error/warning/success  
- Progress indicator: `bg-[var(--primary)]`  
- Tooltip content: `bg-[var(--card)] border border-[var(--border)] text-xs`

- [ ] **Step 4: Build + commit**

```bash
cd dashboard && bun run build
git add dashboard/src/components/ui/
git commit -m "feat(dashboard): restyle dialog, tabs, and remaining ui chrome"
```

---

### Task 4: Shared pattern components

**Files:**
- Create: `dashboard/src/components/ui/page-header.tsx`
- Create: `dashboard/src/components/ui/empty-state.tsx`
- Create: `dashboard/src/components/ui/stat-card.tsx`
- Create: `dashboard/src/components/ui/status-badge.tsx`
- Create: `dashboard/src/components/ui/confirm-dialog.tsx`

- [ ] **Step 1: Create `page-header.tsx`**

```tsx
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
      <div className="space-y-1 min-w-0">
        {eyebrow ? (
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--primary)]">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="font-heading text-2xl font-bold tracking-tight text-[var(--foreground)] sm:text-[28px]">
          {title}
        </h1>
        {description ? (
          <p className="text-sm text-[var(--muted-foreground)] max-w-2xl">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div> : null}
    </div>
  );
}
```

- [ ] **Step 2: Create `empty-state.tsx`**

```tsx
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
      {description ? <p className="mt-1 max-w-sm text-sm text-[var(--muted-foreground)]">{description}</p> : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}
```

- [ ] **Step 3: Create `stat-card.tsx`**

```tsx
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
    <Card
      className={cn(
        emphasize && "border-[var(--primary)]/40 shadow-[var(--glow)]",
        className
      )}
    >
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
```

- [ ] **Step 4: Create `status-badge.tsx`**

```tsx
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Status = "live" | "active" | "success" | "warning" | "error" | "idle" | "offline";

const map: Record<Status, { variant: "success" | "warning" | "error" | "info" | "secondary" | "default"; label?: string }> = {
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
  children?: React.ReactNode;
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
```

- [ ] **Step 5: Create `confirm-dialog.tsx`**

Wrap existing Dialog:

```tsx
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive,
  loading,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={loading}
            onClick={() => void onConfirm()}
          >
            {loading ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

(Adjust imports to match exact exports from current `dialog.tsx` — if `DialogFooter` does not exist, add a simple footer `div` with flex.)

- [ ] **Step 6: Build + commit**

```bash
cd dashboard && bun run build
git add dashboard/src/components/ui/page-header.tsx dashboard/src/components/ui/empty-state.tsx dashboard/src/components/ui/stat-card.tsx dashboard/src/components/ui/status-badge.tsx dashboard/src/components/ui/confirm-dialog.tsx
git commit -m "feat(dashboard): add PageHeader, EmptyState, StatCard, StatusBadge, ConfirmDialog"
```

---

### Task 5: Toast system

**Files:**
- Create: `dashboard/src/hooks/useToast.ts`
- Create: `dashboard/src/components/ui/toast.tsx`
- Modify: `dashboard/src/main.tsx`

- [ ] **Step 1: Create toast store `useToast.ts`**

```ts
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

export function toast(input: { title: string; description?: string; tone?: ToastTone; durationMs?: number }) {
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
```

- [ ] **Step 2: Create `toast.tsx` viewport**

```tsx
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
```

- [ ] **Step 3: Mount in `main.tsx`**

```tsx
import { Toaster } from "./components/ui/toast";

// inside render tree, sibling under ThemeProvider:
<ThemeProvider>
  <WebSocketProvider>
    <BrowserRouter>
      <App />
    </BrowserRouter>
    <Toaster />
  </WebSocketProvider>
</ThemeProvider>
```

- [ ] **Step 4: Build + commit**

```bash
cd dashboard && bun run build
git add dashboard/src/hooks/useToast.ts dashboard/src/components/ui/toast.tsx dashboard/src/main.tsx
git commit -m "feat(dashboard): add lightweight toast system"
```

---

### Task 6: Shell — Layout + Sidebar

**Files:**
- Modify: `dashboard/src/components/layout/Layout.tsx`
- Modify: `dashboard/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Layout polish**

- Keep collapse widths `md:ml-[64px]` / `md:ml-[240px]`.
- Main: `bg-[var(--background)]`.
- Mobile menu button: `rounded-full border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)]`.

- [ ] **Step 2: Sidebar active + labels**

Active NavLink classes (expanded):

```tsx
isActive
  ? "bg-gradient-primary text-white font-semibold shadow-[var(--glow)] rounded-full"
  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)] rounded-full"
```

Section titles:

```tsx
"font-mono text-[10px] font-medium text-[var(--muted-foreground)] uppercase tracking-[0.12em] px-3 mb-2"
```

WS live when open: use gold + optional `animate-ping` on the dot (`var(--gold)` / `var(--success)`).

Brand text: `font-heading` for “Etteum”; mono subtitle optional “proxy ledger”.

Collapse toggle button: rounded-full, border white/10, hover orange border.

- [ ] **Step 3: Build + commit**

```bash
cd dashboard && bun run build
git add dashboard/src/components/layout/Layout.tsx dashboard/src/components/layout/Sidebar.tsx
git commit -m "feat(dashboard): Bitcoin DeFi shell sidebar and layout"
```

---

### Task 7: Login page

**Files:**
- Modify: `dashboard/src/pages/Login.tsx`

- [ ] **Step 1: Visual redesign (keep auth logic)**

Structure:

```tsx
<div className="relative min-h-screen flex items-center justify-center bg-[var(--background)] p-4 overflow-hidden">
  <div className="pointer-events-none absolute inset-0 bg-grid-pattern opacity-60" />
  <div className="pointer-events-none absolute -top-24 right-10 h-64 w-64 rounded-full bg-[var(--primary)] opacity-10 blur-[120px]" />
  <Card className="relative w-full max-w-sm border-[var(--border)] shadow-[var(--glow)]">
    {/* Lock icon in gradient circle */}
    {/* font-heading title Etteum */}
    {/* mono subtitle */}
    {/* Input font-mono */}
    {/* error alert */}
    {/* Button full width gradient */}
  </Card>
</div>
```

Do not change `validateApiKey` flow or localStorage key name `api_key`.

- [ ] **Step 2: Build + commit**

```bash
cd dashboard && bun run build
git add dashboard/src/pages/Login.tsx
git commit -m "feat(dashboard): Bitcoin DeFi login screen"
```

---

### Task 8: Dashboard overview + stats/charts

**Files:**
- Modify: `dashboard/src/pages/Dashboard.tsx`
- Modify: `dashboard/src/components/dashboard/StatsCards.tsx`
- Modify: `dashboard/src/components/dashboard/TokenUsage.tsx` (if present styling)
- Modify: `dashboard/src/components/dashboard/UsageChart.tsx` / `ProviderCards.tsx` as needed

- [ ] **Step 1: Dashboard header**

Replace title block with:

```tsx
import { PageHeader } from "@/components/ui/page-header";

<PageHeader
  eyebrow="Overview"
  title={<>Dashboard <span className="text-gradient-gold">live</span></>}
  description="Pool health, requests, and token throughput"
/>
```

- [ ] **Step 2: StatsCards → StatCard**

Refactor `StatsCards` to map metrics into `<StatCard />` (emphasize success rate card). Use mono values; icons in orange containers. Remove multi-hue chart-2/chart-3 icon colors that fight the orange system (prefer primary/gold/muted).

- [ ] **Step 3: Charts**

Ensure series stroke/fill use `var(--chart-1)` … orange/gold palette (already token-driven if components read CSS vars). Remove any hard-coded `#00ff88`.

- [ ] **Step 4: Build + commit**

```bash
cd dashboard && bun run build
git add dashboard/src/pages/Dashboard.tsx dashboard/src/components/dashboard/
git commit -m "feat(dashboard): restyle overview dashboard and stats"
```

---

### Task 9: Core account pages

**Files:**
- Modify: `dashboard/src/pages/Accounts.tsx`
- Modify: `dashboard/src/pages/AccountList.tsx`
- Modify: `dashboard/src/pages/ByokAccountList.tsx`
- Modify: `dashboard/src/pages/Models.tsx`
- Modify: `dashboard/src/pages/ApiKey.tsx`

- [ ] **Step 1: Pattern application (each page)**

For every page:

1. Import `PageHeader` and replace ad-hoc `<h1>` blocks.
2. Replace custom green status pills with `Badge` / `StatusBadge`.
3. Primary actions use default (gradient) Button; secondary use `outline`/`ghost`.
4. Where pages set inline success/error banner strings, prefer `toast({ title, tone })` for transient feedback; keep inline Alert for blocking form errors.
5. Ensure toolbars use consistent gap/height; wrap on mobile (`flex-wrap`).
6. Grep each file for `#00ff88`, `neon`, hard-coded green, and leftover `glow` misuse — fix to tokens.

Example header for Accounts:

```tsx
<PageHeader
  eyebrow="Accounts"
  title="Provider pool"
  description="Manage provider accounts and automation"
  actions={/* existing add/import buttons */}
/>
```

- [ ] **Step 2: ApiKey page**

- Mono for key display  
- Copy action → `toast({ title: "Copied", tone: "success" })`  
- Button row `flex flex-wrap gap-2`

- [ ] **Step 3: Build + commit**

```bash
cd dashboard && bun run build
git add dashboard/src/pages/Accounts.tsx dashboard/src/pages/AccountList.tsx dashboard/src/pages/ByokAccountList.tsx dashboard/src/pages/Models.tsx dashboard/src/pages/ApiKey.tsx
git commit -m "feat(dashboard): restyle accounts, models, and API key pages"
```

---

### Task 10: Ops pages (Requests, Usage, Proxy, Filters, Settings, Bot Logs)

**Files:**
- Modify: `dashboard/src/pages/Requests.tsx`
- Modify: `dashboard/src/pages/Usage.tsx`
- Modify: `dashboard/src/pages/ProxyPool.tsx`
- Modify: `dashboard/src/pages/FilterRules.tsx`
- Modify: `dashboard/src/pages/Settings.tsx`
- Modify: `dashboard/src/pages/BotLogs.tsx`

- [ ] **Step 1: Apply shared patterns**

Same checklist as Task 9. Dense tables:

- Header cells: `font-mono text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]`
- Technical cells (ids, models): `font-mono text-xs`
- Row hover: `hover:bg-white/5` (dark) — use `hover:bg-[var(--secondary)]/50` for dual theme
- Error rows: subtle `text-[var(--error)]` on status only

Settings / Proxy Pool destructive actions: migrate confirm UX to `ConfirmDialog` when a confirm already exists as `window.confirm` or custom modal — if custom modal exists, restyle only.

- [ ] **Step 2: Build + commit**

```bash
cd dashboard && bun run build
git add dashboard/src/pages/Requests.tsx dashboard/src/pages/Usage.tsx dashboard/src/pages/ProxyPool.tsx dashboard/src/pages/FilterRules.tsx dashboard/src/pages/Settings.tsx dashboard/src/pages/BotLogs.tsx
git commit -m "feat(dashboard): restyle ops pages (requests, proxy, settings, logs)"
```

---

### Task 11: Tools pages (Image Studio, Integration, VCC, OAuth)

**Files:**
- Modify: `dashboard/src/pages/ImageStudio.tsx`
- Modify: `dashboard/src/pages/Integration.tsx`
- Modify: `dashboard/src/pages/VccPool.tsx`
- Modify: `dashboard/src/pages/CodexOAuthCallback.tsx`
- Modify: `dashboard/src/components/integration/*`
- Modify: `dashboard/src/components/vcc/*`

- [ ] **Step 1: Image Studio controls**

- Bump tiny controls to `h-9` / min 36–44px touch targets on mobile  
- PageHeader + surface panels for preview  
- Primary generate button = gradient pill  

- [ ] **Step 2: Integration + VCC**

- Client cards use Card + orange hover border  
- VCC visual cards: keep structure; recolor accents from green to orange/gold  
- Export dialogs use Dialog chrome from Task 3  

- [ ] **Step 3: OAuth callback**

- Simple centered card on void background; mono status text  

- [ ] **Step 4: Build + commit**

```bash
cd dashboard && bun run build
git add dashboard/src/pages/ImageStudio.tsx dashboard/src/pages/Integration.tsx dashboard/src/pages/VccPool.tsx dashboard/src/pages/CodexOAuthCallback.tsx dashboard/src/components/integration dashboard/src/components/vcc
git commit -m "feat(dashboard): restyle tools pages (image studio, integration, vcc)"
```

---

### Task 12: Global sweep + QA

**Files:**
- Modify: any remaining `dashboard/src/**` with green hardcodes / inconsistent headers
- Modify: `dashboard/src/App.tsx` loading fallbacks (optional mono muted styling)

- [ ] **Step 1: Repo grep cleanup**

Run from repo root:

```bash
cd dashboard && grep -RIn --include='*.tsx' --include='*.css' --include='*.ts' '00ff88\|#00a857\|neon\|var(--glow)' src || true
```

Fix leftover neon greens. Keep intentional `glow` utility usage only where primary/active.

Also:

```bash
grep -RIn --include='*.tsx' 'text-2xl font-bold' src/pages || true
```

Prefer migrating remaining raw titles to `PageHeader` where still ad-hoc.

- [ ] **Step 2: Loading fallbacks in App**

```tsx
function RouteFallback() {
  return (
    <div className="flex h-64 items-center justify-center font-mono text-xs uppercase tracking-wider text-[var(--muted-foreground)]">
      Loading…
    </div>
  );
}
```

- [ ] **Step 3: Production build**

```bash
cd dashboard && bun run build
```

Expected: exit 0.

- [ ] **Step 4: Manual QA checklist (record results in commit message or leave notes)**

Dark mode:

1. Login — grid/glow, gradient button, key validation still works  
2. Dashboard — StatCards + charts orange/gold  
3. Accounts — header, table/cards, dialogs  
4. Requests — dense table readable  
5. Sidebar — active pill, collapse, WS indicator  
6. Theme toggle — light readable  

Mobile (~375px):

1. Drawer opens/closes  
2. Buttons not sub-40px on Image Studio critical controls  
3. ApiKey actions wrap  

- [ ] **Step 5: Final commit**

```bash
git add dashboard
git commit -m "feat(dashboard): complete Bitcoin DeFi redesign sweep and QA fixes"
```

---

## Spec coverage check

| Spec requirement | Task(s) |
|------------------|---------|
| Void + orange/gold tokens, dual theme dark-first | 1 |
| Fonts Space Grotesk / Inter / JetBrains Mono | 1 |
| Glow/glass/grid utilities with reduced-motion | 1 |
| Button/Card/Input/Badge primitives | 2 |
| Dialog/Tabs/etc. | 3 |
| PageHeader, EmptyState, StatCard, StatusBadge, ConfirmDialog | 4 |
| Toasts | 5 |
| Sidebar refine, no top bar | 6 |
| Login void aesthetic | 7 |
| Dashboard KPIs/charts | 8 |
| Accounts/Models/API Key | 9 |
| Requests/Usage/Proxy/Settings/Logs | 10 |
| Image Studio/Integration/VCC/OAuth | 11 |
| All pages, kill neon, mobile/a11y sweep | 12 |
| No API/route changes | All (constraint) |

## Placeholder / consistency notes

- Toast API is always `toast({ title, description?, tone? })` from `@/hooks/useToast`.
- Headers always `PageHeader` with optional `eyebrow`.
- Primary CTA always `Button` default variant (gradient).
- Status always `Badge` / `StatusBadge` variants — not ad-hoc green spans.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-23-dashboard-bitcoin-defi-redesign.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — this session with `executing-plans`, batched with checkpoints  

Which approach?
