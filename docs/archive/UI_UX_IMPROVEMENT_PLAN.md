# UI/UX Konsistensi & Mobile Responsive Plan

## Ringkasan Analisis

Setelah analisis mendalam terhadap 13 halaman, 4 UI component, dan 2 layout component, ditemukan **3 kategori utama masalah**:

### 1. Critical Mobile Issues (Harus Diperbaiki)
- **Touch targets terlalu kecil** (< 44px minimum accessibility guideline)
- **ImageStudio controls** tidak usable di mobile (20px buttons)
- **ApiKey buttons** overflow di mobile (tidak wrap)
- **Models table** tidak responsive

### 2. Styling Inconsistencies (Perlu Standarisasi)
- Message/toast styling berbeda-beda di setiap halaman
- Tidak ada shared Select & Textarea component
- Custom status badges dibuat inline (tidak pakai Badge component)

### 3. UX Improvements (Enhancement)
- Mobile navigation bisa lebih baik
- Table views di mobile bisa pakai card layout
- List items di FilterRules & ProxyPool terlalu padat

---

## Implementation Plan

### Phase 1: Critical Mobile Fixes (Priority 1)

#### 1.1 Fix Button Touch Targets
**Files to modify:**
- `src/components/ui/button.tsx`
- All pages using `size="sm"` or `size="icon"`

**Changes:**
```typescript
// button.tsx - Add responsive min-height for mobile
const buttonVariants = cva(
  "... min-h-[44px] md:min-h-0 ..."  // 44px on mobile, normal on desktop
)
```

**Specific fixes:**
- FilterRules.tsx lines 252-283: Increase button size or add padding
- ProxyPool.tsx lines 382-409: Same
- VccPool.tsx lines 314-319: Same
- AccountList.tsx lines 401-413: Same

#### 1.2 Fix ImageStudio Mobile Controls
**File:** `src/pages/ImageStudio.tsx`

**Changes:**
- Lines 417: Increase `max-w-[140px]` to `max-w-[180px]` on mobile
- Lines 439-458: Increase toggle buttons from `h-5` to `h-9` (36px)
- Lines 466-482: Increase number selector from `h-5 w-5` to `h-9 w-9`
- Lines 493: Increase aspect ratio select from `w-16` to `w-24`
- Lines 559: Increase sample prompt buttons text size

**Implementation:**
```tsx
// Toggle buttons
<button
  className={`flex h-9 items-center gap-1.5 rounded-md px-3 text-sm ...`}
>

// Number selector
<button
  className={`flex h-9 w-9 items-center justify-center rounded-md text-sm ...`}
>
```

#### 1.3 Fix ApiKey Button Wrapping
**File:** `src/pages/ApiKey.tsx` lines 143-152

**Change:**
```tsx
<div className="flex flex-wrap gap-2">
  <Button variant="outline" size="sm">Load Active</Button>
  <Button variant="outline" size="sm">Test</Button>
  <Button variant="outline" size="sm">
    <RefreshCw className="w-4 h-4 mr-2" /> Generate
  </Button>
  <Button size="sm">
    <Save className="w-4 h-4 mr-2" /> Save & Activate
  </Button>
</div>
```

#### 1.4 Fix Models Table Responsive
**File:** `src/pages/Models.tsx` lines 119-198

**Add responsive column hiding:**
```tsx
<thead>
  <tr>
    <th className="...">Provider</th>
    <th className="...">Model</th>
    <th className="... hidden sm:table-cell">Input Price</th>
    <th className="... hidden sm:table-cell">Output Price</th>
    <th className="... hidden md:table-cell">Context</th>
    <th className="... hidden lg:table-cell">Actions</th>
  </tr>
</thead>
```

---

### Phase 2: Styling Consistency (Priority 2)

#### 2.1 Create Shared Message/Toast Component
**New file:** `src/components/ui/alert.tsx`

**Implementation:**
```tsx
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const alertVariants = cva(
  "relative w-full rounded-md border p-4 text-sm",
  {
    variants: {
      variant: {
        default: "bg-[var(--background)] text-[var(--foreground)]",
        success: "border-[var(--success)]/30 bg-[var(--success)]/10 text-[var(--success)]",
        warning: "border-[var(--warning)]/30 bg-[var(--warning)]/10 text-[var(--warning)]",
        error: "border-[var(--error)]/30 bg-[var(--error)]/10 text-[var(--error)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export function Alert({ className, variant, ...props }) {
  return <div className={cn(alertVariants({ variant }), className)} {...props} />
}
```

**Files to update:**
- `src/pages/Settings.tsx` line 116
- `src/pages/FilterRules.tsx` line 141
- `src/pages/ProxyPool.tsx` line 237
- `src/pages/VccPool.tsx` line 215
- `src/pages/ApiKey.tsx` line 99
- `src/pages/Accounts.tsx` line 349
- `src/pages/AccountList.tsx` line 310

**Usage:**
```tsx
<Alert variant="success">Settings saved successfully</Alert>
<Alert variant="error">Failed to load data</Alert>
```

#### 2.2 Create Shared Select Component
**New file:** `src/components/ui/select.tsx`

**Implementation:**
```tsx
import * as React from "react"
import { cn } from "@/lib/utils"

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <select
        ref={ref}
        className={cn(
          "h-9 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]",
          className
        )}
        {...props}
      >
        {children}
      </select>
    )
  }
)
Select.displayName = "Select"

export { Select }
```

**Files to update:**
- `src/pages/Settings.tsx` lines 138-145, 187-195
- `src/pages/Requests.tsx` lines 111-116
- `src/pages/ProxyPool.tsx` lines 279-288, 292-303, 306-315
- `src/pages/Accounts.tsx` lines 487-491, 607-610, 618-625, 648-651
- `src/pages/ImageStudio.tsx` lines 414-429, 491-501

#### 2.3 Create Shared Textarea Component
**New file:** `src/components/ui/textarea.tsx`

**Implementation:**
```tsx
import * as React from "react"
import { cn } from "@/lib/utils"

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          "w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm font-mono placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]",
          className
        )}
        {...props}
      />
    )
  }
)
Textarea.displayName = "Textarea"

export { Textarea }
```

**Files to update:**
- `src/pages/FilterRules.tsx` lines 161, 169
- `src/pages/ProxyPool.tsx` line 252
- `src/pages/VccPool.tsx` line 270
- `src/pages/Accounts.tsx` lines 561, 581, 601

#### 2.4 Standardize Status Badges
**Files to update:**
- `src/pages/ProxyPool.tsx` lines 187-198: Replace custom `statusBadge()` with Badge component
- `src/pages/VccPool.tsx` lines 356-360: Use Badge component
- `src/pages/FilterRules.tsx` lines 229-241: Use Badge component

**Example:**
```tsx
// Before (ProxyPool.tsx line 187-198)
const statusBadge = (status: string) => {
  const colors = { ... }
  return <span className={...}>{status}</span>
}

// After
<Badge variant={status === "active" ? "success" : status === "disabled" ? "warning" : "error"}>
  {status}
</Badge>
```

---

### Phase 3: UX Improvements (Priority 3)

#### 3.1 Improve Mobile Navigation
**File:** `src/components/layout/Sidebar.tsx`

**Add:**
- Visual indicator for current page when sidebar closed (small dot/badge)
- Consider adding quick-access floating action button for common actions

**Implementation:**
```tsx
// Add active indicator visible even when sidebar closed
{open && (
  <div className="absolute left-0 top-4 h-8 w-1 bg-[var(--primary)] rounded-r" />
)}
```

#### 3.2 Better Mobile Table Views (Card Layout)
**Files to update:**
- `src/pages/Requests.tsx`
- `src/pages/BotLogs.tsx`
- `src/pages/AccountList.tsx`

**Implementation pattern:**
```tsx
{/* Desktop: Table */}
<div className="hidden md:block">
  <table>...</table>
</div>

{/* Mobile: Cards */}
<div className="md:hidden space-y-3">
  {items.map(item => (
    <Card key={item.id} className="p-4">
      <div className="flex justify-between mb-2">
        <span className="font-medium">{item.name}</span>
        <Badge>{item.status}</Badge>
      </div>
      <div className="space-y-1 text-sm text-[var(--muted-foreground)]">
        <div>Email: {item.email}</div>
        <div>Credit: {item.credit}</div>
      </div>
    </Card>
  ))}
</div>
```

#### 3.3 Improve List Items (FilterRules & ProxyPool)
**Files to update:**
- `src/pages/FilterRules.tsx` lines 219-249
- `src/pages/ProxyPool.tsx` lines 362-411

**Changes:**
- Stack elements vertically on mobile
- Increase touch targets for action buttons
- Add swipe-to-delete on mobile (optional enhancement)

**Example for FilterRules:**
```tsx
<div className="space-y-2">
  {rules.map(rule => (
    <Card key={rule.id} className="p-4">
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant={rule.isRegex ? "default" : "secondary"}>
              {rule.isRegex ? "Regex" : "String"}
            </Badge>
            <Badge variant={rule.isActive ? "success" : "warning"}>
              {rule.isActive ? "Active" : "Inactive"}
            </Badge>
          </div>
          <div className="font-mono text-sm truncate" title={rule.pattern}>
            {rule.pattern}
          </div>
        </div>
      </div>
      
      {/* Action buttons - larger touch targets */}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="flex-1">
          <Power className="w-4 h-4 mr-2" /> Toggle
        </Button>
        <Button variant="outline" size="sm" className="flex-1">
          <Pencil className="w-4 h-4 mr-2" /> Edit
        </Button>
        <Button variant="outline" size="sm" className="flex-1">
          <Trash2 className="w-4 h-4 mr-2" /> Delete
        </Button>
      </div>
    </Card>
  ))}
</div>
```

---

## Testing Checklist

### Mobile Testing (375px - 414px width)
- [ ] All buttons have touch targets ≥ 44px
- [ ] No horizontal overflow
- [ ] Tables readable (card view or minimal columns)
- [ ] Forms usable (inputs, selects, textareas)
- [ ] ImageStudio controls tappable
- [ ] Navigation accessible
- [ ] Modals/dialogs display correctly

### Tablet Testing (768px - 1024px width)
- [ ] Tables show more columns
- [ ] Sidebar visible
- [ ] Layouts transition smoothly

### Desktop Testing (1024px+ width)
- [ ] Full table columns visible
- [ ] All features accessible
- [ ] No regression from changes

### Cross-Browser Testing
- [ ] Chrome (latest)
- [ ] Safari (iOS)
- [ ] Firefox
- [ ] Edge

---

## Files to Create/Modify

### New Files (3)
1. `src/components/ui/alert.tsx`
2. `src/components/ui/select.tsx`
3. `src/components/ui/textarea.tsx`

### Modified Files (16)
1. `src/components/ui/button.tsx`
2. `src/pages/ApiKey.tsx`
3. `src/pages/ImageStudio.tsx`
4. `src/pages/Models.tsx`
5. `src/pages/Settings.tsx`
6. `src/pages/FilterRules.tsx`
7. `src/pages/ProxyPool.tsx`
8. `src/pages/VccPool.tsx`
9. `src/pages/Accounts.tsx`
10. `src/pages/AccountList.tsx`
11. `src/pages/Requests.tsx`
12. `src/pages/BotLogs.tsx`
13. `src/pages/Dashboard.tsx`
14. `src/pages/Usage.tsx`
15. `src/components/layout/Sidebar.tsx`
16. `src/components/layout/Layout.tsx`

---

## Estimated Effort

- **Phase 1** (Critical Fixes): 2-3 hours
- **Phase 2** (Consistency): 3-4 hours
- **Phase 3** (UX Improvements): 4-5 hours
- **Total**: 9-12 hours

---

## Success Metrics

1. ✅ All touch targets ≥ 44px on mobile
2. ✅ Consistent styling across all pages
3. ✅ No horizontal overflow on any page
4. ✅ Tables readable on mobile (card view or responsive columns)
5. ✅ ImageStudio fully usable on mobile
6. ✅ Shared components reduce code duplication by 30%
7. ✅ Consistent message/toast styling
8. ✅ Better mobile navigation UX
