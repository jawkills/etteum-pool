# VCC Pool Upgrade — Best Practice Edition

## Architecture: Pure Real-Time BIN Lookup

**Tidak pakai database BIN lokal.** Semua BIN info di-fetch langsung dari API secara real-time.

### Kenapa Pure Real-Time?

| Approach | Pros | Cons |
|---|---|---|
| ❌ Local DB (327k records) | Offline, fast | **45MB bundle**, outdated data, static |
| ✅ **Real-time API** | **Always up-to-date**, **0KB bundle**, verified data | Requires internet |
| ✅ Hybrid (cache + API) | Balance | Still needs API |

### How It Works

```
User selects BIN
       │
       ▼
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│ LRU Cache   │────▶│ Local DB     │────▶│ binlist.net API  │
│ (100 entry) │     │ (presets)    │     │ (real-time)      │
│ in-memory   │     │ (15 presets) │     │ (up-to-date)     │
└─────────────┘     └──────────────┘     └──────────────────┘
     fast                instant               always fresh
```

1. **Check LRU cache** (in-memory, max 100 entries) → instant
2. **Check curated presets** (15 verified BINs) → instant
3. **Call binlist.net API** → real-time, always up-to-date

### Files Created

| File | Size | Purpose |
|---|---|---|
| `dashboard/src/lib/bin-service.ts` | ~3 KB | Real-time BIN lookup + LRU cache + curated presets |
| `dashboard/src/lib/vcc-utils.ts` | ~5 KB | Card generation, formatting, export, parsing |
| `dashboard/src/components/vcc/VisualCard.tsx` | ~4 KB | Realistic credit card visual component |
| `dashboard/src/components/vcc/ExportDialog.tsx` | ~3 KB | Export cards as TXT/CSV/JSON |
| `dashboard/src/components/vcc/BinSelector.tsx` | ~5 KB | BIN selector with preset + custom + search |
| `dashboard/src/pages/VccPool.tsx` | ~15 KB | Complete page rewrite with tabs |

### Files Removed

| File | Size | Reason |
|---|---|---|
| `dashboard/src/lib/bin-database.json` | **45 MB** | Replaced with real-time API |
| `scripts/parse-bin-database.cjs` | ~3 KB | No longer needed |

### Bundle Impact

```
Before: VccPool.js = 44,934 kB (44 MB gzipped: 2.6 MB)
After:  VccPool.js = 27 kB     (27 KB gzipped: 7.5 KB)

Reduction: 99.94% smaller!
```

## Features

### 1. Real-Time BIN Lookup
- **API:** [binlist.net](https://binlist.net) — free, no API key needed
- **Data:** Brand, Type (credit/debit), Country, Bank/Issuer, Category
- **Always current:** API reflects real-time BIN data
- **Rate limit:** 5 req/hour burst (LRU cache prevents repeat lookups)

### 2. Curated Presets (15 verified BINs)
```
411111  Visa        Test Card
424242  Visa        Test Card
400005  Visa        Debit
555555  Mastercard  Test Card
510510  Mastercard  Test Card
222300  Mastercard  2-series
378282  Amex        Test Card
371449  Amex        Test Card
601111  Discover    Test Card
601100  Discover    Test Card
353011  JCB         Test Card
356600  JCB         Test Card
620000  UnionPay    Test Card
305693  Diners      Test Card
367001  Diners      Test Card
```

### 3. BIN Selector Component
- **Preset dropdown** — 15 curated, verified BINs
- **Custom BIN input** — enter any 6-8 digit BIN
- **Search** — filter presets by BIN, brand, or label
- **Live BIN info panel** — shows brand, country, bank, type, category
- **Refresh button** — force re-fetch from API
- **Brand indicator** — auto-detected from card number prefix

### 4. Generator
- Select BIN (preset or custom) → see real-time BIN info
- Set count (1-100 cards)
- Auto-detect card length (16 for Visa/MC, 15 for Amex)
- Auto-generate Luhn-valid numbers
- Random expiry dates (1-5 years from now)
- Auto CVV (3 digits, 4 for Amex)
- BIN info attached to each card (bank name, country)

### 5. Visual Card Display
- Realistic credit card with brand-specific gradients
- Brand logos (Visa, MC, Amex, Discover, JCB, UnionPay, Diners)
- Formatted card number, expiry, cardholder name
- Hover actions: Copy, Delete

### 6. Export (TXT / CSV / JSON)
- **TXT:** `number|mm/yy|cvv` per line
- **CSV:** Full CSV with headers (Number, Exp, CVV, Brand, Issuer, Country)
- **JSON:** Structured JSON with all card details + BIN info

### 7. Copy to Clipboard
- Copy individual card
- Copy all generated cards
- Format: `number|mm/yy|cvv`

### 8. Import with Auto-Detect
Supports multiple formats:
- `number|mm/yy|cvv`
- `number|mm|yy|cvv`
- `number mm/yy cvv`
- `number mm yy cvv`

### 9. Statistics Panel
- Total cards in pool
- Count by brand (Visa, Mastercard, Amex, Other)

### 10. Tabs Organization
- **Generator** — BIN selector + live preview + generate
- **Generated** — visual card grid with copy/export
- **Pool** — bulk import + active cards list
- **History** — transaction log

## Build Status

```
✓ TypeScript compilation: PASS
✓ Vite build: PASS (1.15s)
✓ Bundle size: 27 KB (was 44 MB)
✓ No errors, no warnings
```
