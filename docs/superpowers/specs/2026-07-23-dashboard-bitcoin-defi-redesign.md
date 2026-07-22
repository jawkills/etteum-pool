# Dashboard Redesign: Bitcoin DeFi Aesthetic

**Date:** 2026-07-23  
**Status:** Approved design  
**Scope:** Full product polish of `dashboard/` (all routes)  
**Approach:** Design-system first  

## Summary

Redesign the Etteum Pool dashboard from the current neon-green / VS Code dark theme into a **Bitcoin DeFi** visual system: true-void dark surfaces, Bitcoin orange + digital gold energy, technical typography, colored luminescence, and glass/grid depth — applied consistently across the entire admin UI.

This is **visual and UX polish only**. Routes, APIs, WebSocket events, and product capabilities stay the same.

## Goals

- Instant “secure / technical / digital gold ops” read on Login and Dashboard (dark).
- One coherent design system (tokens + shared components) instead of page-local one-offs.
- All current pages restyled; none left on neon-green tokens.
- Light mode remains usable as a quieter fallback (dark is primary).
- Mobile usable: drawer nav, ≥44px touch targets, critical tables → cards.
- Build stays green; no intentional API/backend regressions.

## Non-goals

- New features, routes, or proxy/backend behavior.
- Replacing Recharts, React Router, or introducing a paid UI kit.
- Full marketing landing / heavy 3D orbital animations on dense ops pages.
- Perfect visual parity of light mode with dark (dark-first is intentional).

## Current system (baseline)

| Area | Today |
|------|--------|
| Stack | React 19, Vite, Tailwind 4, Radix, CVA, Lucide, Recharts, react-router |
| Theme | Dark default + light via `.light`; neon green primary (`#00ff88`) + glow |
| Shell | Collapsible left sidebar with sections (Accounts / Tools / Proxy / Logs) |
| UI kit | `dashboard/src/components/ui/*` (button, card, dialog, input, …) |
| Pages | Login, Dashboard, Accounts (+ lists), Models, API Key, Proxy Pool, VCC Pool, Filter Rules, Settings, Requests, Bot Logs, Usage, Image Studio, Integration, OAuth callback |

## Design philosophy

**Bitcoin DeFi for an ops console** — not a generic dark admin, not a crypto marketing landing pasted onto tables.

1. **Luminescent energy** — light comes from interactive elements (orange/gold glow on primary, active, focus, key hovers).
2. **Mathematical precision** — 1px borders, mono for technical data, clear grids.
3. **Layered depth** — surface stack + selective glass/blur; no heavy skeuomorphism.
4. **Textured void** — optional faint grid + ambient radial blurs on Login/shell accents only.
5. **Trust through hierarchy** — high contrast, scannable KPIs, restrained accent use.

### Ops constraints (usability guardrails)

- Glow is **reserved** for primary CTAs, active nav, focus rings, card hover, and live status — not every control.
- Tables and logs stay **dense and readable**.
- No endless float/orbit animations on Accounts, Requests, Settings, etc.
- `prefers-reduced-motion` disables ambient ping/float loops.

## Visual language

### Color (dark-first)

| Token role | Value | Usage |
|------------|--------|--------|
| Background | `#030304` | App canvas (true void) |
| Surface / card | `#0F1115` | Cards, panels, elevated chrome |
| Foreground | `#FFFFFF` | Primary text |
| Muted | `#94A3B8` | Secondary text, metadata |
| Border | `rgba(255,255,255,0.10)` | Default 1px structure |
| Primary | `#F7931A` | Bitcoin orange — CTAs, links, active, focus |
| Primary deep | `#EA580C` | Gradient start, secondary warmth |
| Gold | `#FFD600` | Highlights, success-leaning live, gradient end |
| Destructive | red family on void (e.g. `#F87171` / deep red surfaces) | Errors, delete |
| Warning | amber family | Non-fatal warnings |
| Info | cool slate-blue if needed | Rare; avoid rainbow UI |

**Signature gradients**

- Primary control: `linear-gradient(to right, #EA580C, #F7931A)`
- Emphasis text (sparingly): `linear-gradient(to right, #F7931A, #FFD600)` + `bg-clip-text`

**Shadows / glow**

- Primary glow: soft orange (`rgba(234,88,12,…)` / `rgba(247,147,26,…)`)
- Gold glow: for live/value accents
- No pure black-only decorative glows as the signature; elevation can combine subtle dark + tinted orange

### Light mode (fallback)

- Neutral cool light canvas + white cards
- Primary remains orange (deepened for contrast, e.g. burnt orange on white)
- **Reduced glow**; hairline borders and soft neutral shadows instead of void luminescence
- Theme toggle remains; dark is the designed hero experience

### Typography

| Role | Family | Usage |
|------|--------|--------|
| Headings | **Space Grotesk** | Page titles, card titles, section heads |
| Body / UI | **Inter** | Descriptions, buttons labels, forms |
| Mono / data | **JetBrains Mono** | Stats, tokens, keys, IDs, badges, nav section labels, table technical columns |

Hierarchy: strong title contrast; mono uppercase tracked **eyebrows** for section labels; comfortable body size (14px base).

### Shape

- Cards / major panels: `rounded-2xl` (16px) or `rounded-xl` (12px)
- Buttons: `rounded-full` (pill)
- Inputs: `rounded-lg` or terminal bottom-border style
- Badges / status chips: pill or `rounded-lg`

### Borders

- Default: `1px` `white/10` (dark) or soft neutral (light)
- Hover (interactive cards): border shifts toward orange at partial opacity
- Focus: full orange ring / border + optional soft glow

## Shell & navigation

**Keep structure:** left sidebar with existing section groups and routes.

**Restyle:**

| Element | Treatment |
|---------|-----------|
| Sidebar width | 240px expanded · 64px collapsed · mobile drawer ~280–320px |
| Rail surface | Void / dark matter; optional light glass (`backdrop-blur` + translucent surface) |
| Brand mark | Gradient badge + soft orange glow |
| Section labels | JetBrains Mono, uppercase, tracked, muted |
| Active item | Gradient pill + primary glow (not neon outline) |
| Inactive item | Muted text; hover subtle surface |
| Footer chrome | WS live (gold ping dot) · theme toggle · logout |
| Main padding | 16px mobile / 24px desktop; content scrolls independently |
| Top global bar | **Not added** in this redesign |

**Mobile:** existing drawer pattern refined (dim backdrop, close control, full nav list).

## Shared page anatomy

Every route uses:

1. **PageHeader** — mono eyebrow · Space Grotesk title · muted description · right action cluster (pills)
2. **Toolbar** (optional) — search, filters, bulk actions — single consistent bar
3. **Content** — StatCard row and/or main panel (table / cards / form / chart)
4. **Feedback** — toasts for transient success/error; inline Alert for blocking page errors; ConfirmDialog for destructive actions
5. **Empty / loading / error** — shared EmptyState, skeletons, error panel

### Status language

| State | Treatment |
|-------|-----------|
| Live / healthy | Gold or soft success on void; optional ping |
| Primary / in progress | Orange |
| Error | Red status pill + mono label |
| Idle / neutral | Slate muted |

No rainbow multi-color badge systems.

### Data display

- Desktop: surface table inside card (`#0F1115`, hairline borders)
- Mobile: critical tables → stacked cards (status pill top-right)
- IDs, emails, token counts, keys: mono
- Charts: orange/gold series on void; drop neon multi-hue chart palette

### Motion

- Interaction transitions: 200–300ms
- Live indicators: restrained ping on WS/status
- Login may use ambient radial blur / grid; **not** full orbital hero on every ops page
- Respect `prefers-reduced-motion`

## Page coverage

| Area | Pages | Polish focus |
|------|-------|----------------|
| Auth | Login, Codex OAuth callback | Void + grid + ambient glow; terminal API key input; gradient pill submit |
| Overview | Dashboard, Usage | StatCards, token breakdown, model usage mono stats, orange charts |
| Accounts | Accounts, AccountList, ByokAccountList, Models | Toolbar, DataTable/cards, StatusBadge, dialogs, empty states |
| Proxy ops | API Key, Proxy Pool, VCC Pool, Filter Rules, Settings | Form density, copy toasts, ConfirmDialog, consistent cards |
| Tools | Image Studio, Integration | Touch-friendly controls, surface/glass preview panels, client cards |
| Logs | Requests, Bot Logs | Dense mono tables, filter chips, row detail dialog, error/success discipline |

## Architecture

### Principles

- **Design-system first** — tokens and shared components before page sweeps.
- **Keep stack** — React 19, Vite, Tailwind 4, Radix, CVA, Lucide, Recharts, react-router.
- **Centralize tokens** in `dashboard/src/index.css`; map into Tailwind theme utilities.
- **Extend existing kit** in `dashboard/src/components/ui/*` and small layout/pattern components — no new UI framework package.
- **No API/route changes.**
- Match existing folder layout, `cn()`, CVA patterns, `@/` aliases.

### Token layer (`dashboard/src/index.css`)

- Remap semantic variables: `--background`, `--foreground`, `--card`, `--primary`, `--muted`, `--border`, `--ring`, status tokens, sidebar tokens, chart series.
- Add effect tokens: e.g. `--glow-primary`, `--glow-gold`, `--shadow-card`, `--gradient-primary`.
- Font variables + load Space Grotesk, Inter, JetBrains Mono.
- Helpers: `.font-heading`, `.font-body`, `.font-mono`; optional `.bg-grid-pattern` for Login/shell accents.
- Dark on `:root`; `.light` as simplified fallback.

### Component inventory

**Upgrade existing**

- Button — pill; gradient primary + glow; outline; ghost; link; destructive; mobile min touch sizes retained
- Card — void surface, white/10 border, hover orange border/glow
- Input, Textarea, Select — dark terminal/minimal; orange focus
- Badge, Alert, Tabs, Dialog, Progress, Tooltip

**Add shared patterns**

- `PageHeader`
- `EmptyState`
- `StatCard`
- `StatusBadge`
- `DataToolbar` (+ table/list helpers as needed)
- Toast provider (sonner-style or lightweight custom)
- `ConfirmDialog` (Dialog wrapper)

**Layout**

- Restyle only `Layout.tsx` and `Sidebar.tsx` (section model stays).

### Rollout phases

1. **Foundation** — tokens, fonts, base ui components, theme wiring  
2. **Shell** — Layout, Sidebar, Login, PageHeader  
3. **Core pages** — Dashboard, Accounts (+ lists), Models, API Key  
4. **Ops pages** — Requests, Usage, Proxy Pool, Filter Rules, Settings, Bot Logs  
5. **Tools** — Image Studio, Integration, VCC Pool, OAuth callback polish  
6. **Sweep** — remove one-off styles, empty/loading consistency, mobile pass, reduced-motion, light+dark QA  

Phases are delivery order inside one redesign initiative (all pages still in scope).

## Accessibility

- White-on-void high contrast for primary text; ensure orange controls meet large-text / UI contrast where required.
- Visible `focus-visible` rings (orange).
- Semantic headings and controls preserved.
- Touch targets ≥44px on mobile for primary actions.
- `prefers-reduced-motion` honored for ambient animation.

## Testing / verification

- `dashboard` production build succeeds.
- Manual dark QA: Login, Dashboard, one list page (Accounts), one dense log page (Requests), Settings.
- Manual light QA: same paths remain readable (quieter is OK).
- Mobile width: drawer opens/closes; primary actions tappable; no unusable 20px controls on Image Studio-class UIs.
- WS status indicator still reflects connection.
- No intentional changes to API client contracts or route paths.

## Success criteria

1. Neon green brand tokens are gone from the dashboard theme.  
2. Dark UI reads as Bitcoin orange / void digital-gold ops.  
3. Shared PageHeader / status / toast / empty patterns used across pages.  
4. All listed routes restyled.  
5. Light mode usable; dark is best experience.  
6. Build passes.

## Decisions log

| Decision | Choice |
|----------|--------|
| Scope | Full product polish, all pages |
| Implementation approach | Design-system first |
| Visual direction | **Full Bitcoin DeFi** (user override from earlier teal shadcn ops) |
| Brand color | Bitcoin orange + digital gold (not teal) |
| Shell | Refine current sidebar (no top bar) |
| Theme | Dark-first; light simplified fallback |
| Glow / glass | Allowed with ops guardrails |
| Feature scope | Visual/UX only |

## Open implementation notes (non-blocking)

- Exact toast library (sonner vs custom) chosen at implementation for bundle/fit.
- Font loading method (Google Fonts link vs self-hosted/fontsource) chosen for offline/privacy fit with existing install story.
- Whether theme toggle remains prominent or demoted is a shell detail; toggle stays functional.

## References

- User-supplied Bitcoin DeFi design-system prompt (colors, type, glow, components, motion).
- Existing dashboard: `dashboard/src/index.css`, `components/ui/*`, `components/layout/*`, `pages/*`.
- Prior UI notes (archive): `docs/archive/UI_UX_IMPROVEMENT_PLAN.md` (mobile/consistency debt still relevant under new skin).
