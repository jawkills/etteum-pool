/** Error classification + center quota signals for grok-cli. */

import {
  isDeadErrorMessage,
  isMissingCredentialMessage,
  isPermanentRevocation,
} from "../../account-health";
import { GROK_CLI_CREDIT_SOFT_ERROR, GROK_CLI_TOKEN_LIMIT } from "./constants";

export type GrokCliErrorKind = "exhausted" | "dead" | "auth" | null;

/**
 * Classify center chat/image failures.
 * Live free/personal path returns HTTP 402 + code personal-team-blocked:spending-limit
 * (hyphenated, not "spending limit") and "run out of credits" — not only 403.
 */
export function classifyGrokCliError(status: number, body: string): GrokCliErrorKind {
  const low = (body || "").toLowerCase();
  if (low.includes("invalid_grant") || low.includes("revoked") || low.includes("unknown refresh")) {
    if (status === 401 || status === 403) return "dead";
    if (status !== 402) return "dead";
  }
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
  if (status === 401) {
    return "auth";
  }
  if (low.includes("invalid_grant") || low.includes("revoked")) return "dead";
  return null;
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

export type GrokCliRateLimitSnapshot = {
  limitTokens?: number;
  remainingTokens?: number;
  limitRequests?: number;
  remainingRequests?: number;
};

/** Parse cli-chat-proxy x-ratelimit-* headers (center free-window truth). */
export function parseGrokCliRateLimitHeaders(
  headers: HeaderLike | null | undefined
): GrokCliRateLimitSnapshot {
  const out: GrokCliRateLimitSnapshot = {};
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
export function parseGrokCliExhaustedBody(
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
export function quotaFromGrokCliCenterSignals(opts: {
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
  const rl = parseGrokCliRateLimitHeaders(opts.headers);
  const exhaustedBody = parseGrokCliExhaustedBody(opts.body || "");
  const kind = classifyGrokCliError(opts.status ?? 0, opts.body || "");

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

  if (rl.limitTokens != null || rl.remainingTokens != null) {
    const limit =
      rl.limitTokens != null && rl.limitTokens > 0 ? rl.limitTokens : GROK_CLI_TOKEN_LIMIT;
    const remaining = rl.remainingTokens != null ? Math.max(0, rl.remainingTokens) : limit;
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

  if (kind === "exhausted") {
    return {
      limit: GROK_CLI_TOKEN_LIMIT,
      remaining: 0,
      used: GROK_CLI_TOKEN_LIMIT,
      resetAt: null,
      source: "upstream-exhausted",
      exhausted: true,
    };
  }

  return null;
}

/**
 * True when this account must not be selected for traffic.
 * Includes permanent IdP death AND missing credentials.
 */
export function isGrokCliDeadError(error?: string | null): boolean {
  return isDeadErrorMessage(error);
}

/** IdP revocation only (invalid_grant) — reauth/re-farm. */
export function isGrokCliPermanentRevocation(error?: string | null): boolean {
  return isPermanentRevocation(error);
}

export type GrokAuthClass = "permanent" | "missing" | "auth";

export function classifyGrokAuthFailure(error?: string | null): GrokAuthClass {
  if (isPermanentRevocation(error)) return "permanent";
  if (isMissingCredentialMessage(error)) return "missing";
  if (isDeadErrorMessage(error)) return "missing";
  return "auth";
}

export function formatGrokCliDeadError(detail: string): string {
  const cleaned = (detail || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!cleaned) return "Grok CLI dead: refresh token revoked";
  if (cleaned.toLowerCase().startsWith("grok cli dead:")) return cleaned;
  if (isMissingCredentialMessage(cleaned)) return cleaned;
  return `Grok CLI dead: ${cleaned}`;
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
      error: formatGrokCliDeadError(raw),
      deadAccount: true,
      permanent: true,
      kind,
    };
  }
  if (kind === "missing") {
    return { error: raw, deadAccount: true, permanent: false, kind };
  }
  return {
    error: raw.startsWith("Grok CLI auth:") ? raw : `Grok CLI auth: ${raw}`,
    deadAccount: false,
    permanent: false,
    kind,
  };
}

// Re-export soft error for convenience at this seam
export { GROK_CLI_CREDIT_SOFT_ERROR };
