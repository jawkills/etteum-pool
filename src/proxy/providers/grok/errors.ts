/** Error classification + center quota signals for grok-cli. */

import {
  isDeadErrorMessage,
  isMissingCredentialMessage,
  isPermanentRevocation,
} from "../../account-health";
import { GROK_CREDIT_SOFT_ERROR } from "./constants";

export type GrokErrorKind = "exhausted" | "dead" | "auth" | "rate_limited" | null;

/**
 * Body patterns that indicate transient upstream overload (not account/quota).
 * Matches "at capacity", "high demand", "overloaded", "service tier",
 * "priority processing", "temporarily unavailable".
 */
const CAPACITY_PATTERNS: readonly RegExp[] = [
  /at capacity/i,
  /high demand/i,
  /overloaded/i,
  /temporarily unavailable/i,
  /service tier/i,
  /priority processing/i,
];

function matchesCapacityBody(body: string): boolean {
  return CAPACITY_PATTERNS.some((re) => re.test(body || ""));
}

/**
 * Classify center chat/image failures.
 * Live free/personal path returns HTTP 402 + code personal-team-blocked:spending-limit
 * (hyphenated, not "spending limit") and "run out of credits" — not only 403.
 *
 * Ordering matters:
 *   1. dead (revocation) — checked first so invalid_grant always wins
 *   2. exhausted (quota/credits) — checked BEFORE rate_limited so 429+quota body
 *      stays "exhausted" and not "rate_limited"
 *   3. rate_limited (capacity/429-no-quota/503/529) — transient upstream overload
 *   4. auth (401 generic)
 *   5. null (unknown — caller decides)
 */
export function classifyGrokError(status: number, body: string): GrokErrorKind {
  const low = (body || "").toLowerCase();
  if (low.includes("invalid_grant") || low.includes("revoked") || low.includes("unknown refresh")) {
    if (status === 401 || status === 403) return "dead";
    if (status !== 402) return "dead";
  }
  // --- exhausted: account-level quota/credit death (must run before rate_limited) ---
  if (
    status === 402 ||
    status === 403 ||
    low.includes("spending limit") ||
    low.includes("spending-limit") ||
    low.includes("personal-team-blocked") ||
    low.includes("credits are exhausted") ||
    low.includes("run out of credits") ||
    low.includes("free-usage-exhausted") ||
    low.includes("need a grok subscription") ||
    (status === 429 && /tokens\s*\(actual\/limit\)|free-usage|quota|credit/i.test(low)) ||
    (low.includes("quota") && /exhaust|exceed|limit|spent|usage/i.test(low))
  ) {
    return "exhausted";
  }
  // --- rate_limited: transient upstream overload, NOT account-quota death ---
  // Server-side capacity/overload signals first.
  if (matchesCapacityBody(low)) {
    return "rate_limited";
  }
  // Status-code-only signals: 529 (over capacity), 503 (service unavailable).
  if (status === 529 || status === 503) {
    return "rate_limited";
  }
  // 429 that didn't match the exhausted branch above is a plain rate-limit.
  if (status === 429) {
    return "rate_limited";
  }
  // "rate limit" / "too many requests" text at any status.
  if (/rate limit|too many requests/i.test(low)) {
    return "rate_limited";
  }
  if (status === 401) {
    return "auth";
  }
  if (low.includes("invalid_grant") || low.includes("revoked")) return "dead";
  return null;
}

/**
 * Parse the RFC 7231 `Retry-After` response header into a delay in milliseconds.
 *
 * Accepts either:
 *   - delta-seconds (e.g. "5" -> 5000ms)
 *   - HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT" -> ms until that time)
 *
 * Returns undefined when the header is missing or unparseable. Positive values
 * are clamped to [1000, 10000] so a malicious/huge upstream hint cannot stall
 * the proxy beyond its retry budget. Past dates clamp to the 1000ms minimum.
 */
export function parseRetryAfterMs(
  headers: HeaderLike | null | undefined
): number | undefined {
  const raw = headerGet(headers, "retry-after");
  if (raw == null || raw === "") return undefined;
  const trimmed = raw.trim();

  // delta-seconds form (most common)
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return clampRetryMs(seconds * 1000);
  }

  // HTTP-date form
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return undefined;
  const deltaMs = dateMs - Date.now();
  // Past dates clamp to the minimum (treat as "retry immediately-ish").
  return clampRetryMs(Math.max(0, deltaMs));
}

function clampRetryMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 1000;
  return Math.min(10_000, Math.max(1000, Math.round(ms)));
}

type HeaderLike =
  | Headers
  | Record<string, string | string[] | undefined | null>
  | { get?(name: string): string | null | undefined };

function headerGet(headers: HeaderLike | null | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    const v = (headers as Headers).get(name);
    return v == null ? undefined : String(v);
  }
  const rec = headers as Record<string, string | string[] | undefined | null>;
  const direct = rec[name] ?? rec[name.toLowerCase()] ?? rec[name.toUpperCase()];
  if (direct == null) {
    const want = name.toLowerCase();
    for (const [k, v] of Object.entries(rec)) {
      if (k.toLowerCase() === want) {
        return Array.isArray(v) ? v[0] : v == null ? undefined : String(v);
      }
    }
    return undefined;
  }
  return Array.isArray(direct) ? direct[0] : String(direct);
}

function headerInt(headers: HeaderLike | null | undefined, name: string): number | undefined {
  const raw = headerGet(headers, name);
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

export type GrokRateLimitSnapshot = {
  limitTokens?: number;
  remainingTokens?: number;
  limitRequests?: number;
  remainingRequests?: number;
};

/** Parse cli-chat-proxy x-ratelimit-* headers (center free-window truth). */
export function parseGrokRateLimitHeaders(
  headers: HeaderLike | null | undefined
): GrokRateLimitSnapshot {
  const out: GrokRateLimitSnapshot = {};
  const limitTokens = headerInt(headers, "x-ratelimit-limit-tokens");
  const remainingTokens = headerInt(headers, "x-ratelimit-remaining-tokens");
  const limitRequests = headerInt(headers, "x-ratelimit-limit-requests");
  const remainingRequests = headerInt(headers, "x-ratelimit-remaining-requests");
  if (limitTokens != null) out.limitTokens = limitTokens;
  if (remainingTokens != null) out.remainingTokens = remainingTokens;
  if (limitRequests != null) out.limitRequests = limitRequests;
  if (remainingRequests != null) out.remainingRequests = remainingRequests;
  return out;
}

/**
 * Parse 429 free-usage body: `tokens (actual/limit): 1053503/1000000`.
 * remaining is max(0, limit - actual) — can be 0 when actual > limit.
 */
export function parseGrokExhaustedBody(
  body: string
): { actual: number; limit: number; remaining: number } | null {
  const m = /tokens\s*\(actual\/limit\)\s*:\s*(\d+)\s*\/\s*(\d+)/i.exec(body || "");
  if (!m) return null;
  const actual = Number(m[1]);
  const limit = Number(m[2]);
  if (!Number.isFinite(actual) || !Number.isFinite(limit) || limit <= 0) return null;
  return { actual, limit, remaining: Math.max(0, limit - actual) };
}

/** Build quota snapshot from center headers and/or exhausted body. */
export function quotaFromGrokCenterSignals(opts: {
  headers?: HeaderLike | null;
  body?: string;
  status?: number;
}): {
  limit: number;
  remaining: number;
  used: number;
  resetAt: null;
  source: string;
  exhausted: boolean;
} | null {
  const rl = parseGrokRateLimitHeaders(opts.headers);
  const exhaustedBody = parseGrokExhaustedBody(opts.body || "");
  const kind = classifyGrokError(opts.status ?? 0, opts.body || "");

  // Prefer explicit body numbers (actual/limit) — center free-window truth.
  if (exhaustedBody) {
    return {
      limit: exhaustedBody.limit,
      remaining: exhaustedBody.remaining,
      used: exhaustedBody.actual,
      resetAt: null,
      source: "upstream-body",
      exhausted: true,
    };
  }

  // Headers only count when limit is present. Never invent a fake ceiling
  // (old bug: fallback 2_000_000 when center only sent remaining).
  if (rl.limitTokens != null && rl.limitTokens > 0) {
    const limit = rl.limitTokens;
    const remaining =
      rl.remainingTokens != null ? Math.max(0, rl.remainingTokens) : limit;
    const used = Math.max(0, limit - remaining);
    return {
      limit,
      remaining,
      used,
      resetAt: null,
      source: "upstream-headers",
      exhausted: kind === "exhausted" || remaining <= 0,
    };
  }

  // Exhausted without parseable numbers: caller marks remaining=0 only;
  // do not invent limit (warmup preserves prior quota_limit when quota omitted).
  return null;
}

/**
 * True when this account must not be selected for traffic.
 * Includes permanent IdP death AND missing credentials.
 */
export function isGrokDeadError(error?: string | null): boolean {
  return isDeadErrorMessage(error);
}

/** IdP revocation only (invalid_grant) — reauth/re-farm. */
export function isGrokPermanentRevocation(error?: string | null): boolean {
  return isPermanentRevocation(error);
}

export type GrokAuthClass = "permanent" | "missing" | "auth";

export function classifyGrokAuthFailure(error?: string | null): GrokAuthClass {
  if (isPermanentRevocation(error)) return "permanent";
  if (isMissingCredentialMessage(error)) return "missing";
  if (isDeadErrorMessage(error)) return "missing";
  return "auth";
}

export function formatGrokDeadError(detail: string): string {
  const cleaned = (detail || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!cleaned) return "Grok dead: refresh token revoked";
  if (cleaned.toLowerCase().startsWith("grok dead:")) return cleaned;
  if (isMissingCredentialMessage(cleaned)) return cleaned;
  return `Grok dead: ${cleaned}`;
}

export function formatGrokAuthFailure(error?: string | null): {
  error: string;
  deadAccount: boolean;
  permanent: boolean;
  kind: GrokAuthClass;
} {
  const raw = (error || "").replace(/\s+/g, " ").trim() || "refresh failed";
  const kind = classifyGrokAuthFailure(raw);
  if (kind === "permanent") {
    return {
      error: formatGrokDeadError(raw),
      deadAccount: true,
      permanent: true,
      kind,
    };
  }
  if (kind === "missing") {
    return { error: raw, deadAccount: true, permanent: false, kind };
  }
  return {
    error: raw.startsWith("Grok auth:") ? raw : `Grok auth: ${raw}`,
    deadAccount: false,
    permanent: false,
    kind,
  };
}

// Re-export soft error for convenience at this seam
export { GROK_CREDIT_SOFT_ERROR };

// deprecated aliases for transition
export type GrokCliErrorKind = GrokErrorKind;
export type GrokCliRateLimitSnapshot = GrokRateLimitSnapshot;
export const classifyGrokCliError = classifyGrokError;
export const parseGrokCliRateLimitHeaders = parseGrokRateLimitHeaders;
export const parseGrokCliExhaustedBody = parseGrokExhaustedBody;
export const quotaFromGrokCliCenterSignals = quotaFromGrokCenterSignals;
export const isGrokCliDeadError = isGrokDeadError;
export const isGrokCliPermanentRevocation = isGrokPermanentRevocation;
export const formatGrokCliDeadError = formatGrokDeadError;
export { GROK_CREDIT_SOFT_ERROR as GROK_CLI_CREDIT_SOFT_ERROR };
