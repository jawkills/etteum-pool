/**
 * Shared account health classification (runtime + ops audit).
 * Pure helpers only — no DB writes, no upstream calls.
 */

export type TokenFreshness = "fresh" | "expired" | "unknown" | "no_token";

export type TokenInspection = {
  hasAccess: boolean;
  hasRefresh: boolean;
  expiresAtSec: number | null;
  secondsLeft: number | null;
  freshness: TokenFreshness;
  /** True when tokens object exists but has no access/refresh fields (session blob). */
  opaqueSession: boolean;
};

export type OfflineAccountInput = {
  status?: string | null;
  enabled?: boolean | number | null;
  errorMessage?: string | null;
  tokens?: unknown;
};

export type OfflineAccountClass = {
  enabled: boolean;
  status: string;
  dbActive: boolean;
  freshness: TokenFreshness;
  hasAccess: boolean;
  hasRefresh: boolean;
  secondsLeft: number | null;
  /** Permanent-death wording in error_message (invalid_grant, revoked, …). */
  revokedLooking: boolean;
  /** status === "error" (may include non-revoke failures). */
  errorStatus: boolean;
  /**
   * Likely able to serve traffic without re-farm:
   * enabled+active, not revoked-looking, and either fresh access,
   * expired-but-refreshable, or unknown-expiry session with tokens.
   */
  usable: boolean;
  /** enabled+active but not usable (no token / revoked msg / expired without refresh). */
  zombieActive: boolean;
  /** usable subset: access expired but refresh present and not revoked-looking. */
  refreshable: boolean;
};

/** Parse expires_at from unix sec/ms or ISO-8601 string. */
export function parseExpiresAtSec(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw > 1e12 ? Math.floor(raw / 1000) : raw;
  }
  const s = String(raw).trim();
  if (!s) return null;
  const asNum = Number(s);
  if (Number.isFinite(asNum) && asNum > 0) {
    return asNum > 1e12 ? Math.floor(asNum / 1000) : asNum;
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

/**
 * Permanent session death (revoked refresh, missing access, explicit dead prefix).
 * Keep this aligned with runtime markError decisions — do not treat
 * transient health kinds (session_expired, network) as permanent death.
 */
export function isDeadErrorMessage(error?: string | null): boolean {
  if (!error) return false;
  const low = error.toLowerCase();
  return (
    low.includes("invalid_grant") ||
    low.includes("revoked") ||
    low.includes("unknown refresh") ||
    low.includes("grok cli dead") ||
    low.includes("account dead") ||
    low.includes("no access_token for grok-cli") ||
    // bare missing credentials (ops + some providers)
    low.includes("no access_token") ||
    low.includes("no refresh_token")
  );
}

export function inspectTokens(
  tokensRaw: unknown,
  nowSec = Math.floor(Date.now() / 1000),
  leadSec = 45 * 60
): TokenInspection {
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed = typeof tokensRaw === "string" ? JSON.parse(tokensRaw) : tokensRaw;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      obj = parsed as Record<string, unknown>;
    }
  } catch {
    obj = null;
  }

  if (!obj) {
    return {
      hasAccess: false,
      hasRefresh: false,
      expiresAtSec: null,
      secondsLeft: null,
      freshness: "no_token",
      opaqueSession: false,
    };
  }

  const nested =
    obj.tokens && typeof obj.tokens === "object" && !Array.isArray(obj.tokens)
      ? (obj.tokens as Record<string, unknown>)
      : null;

  const access =
    obj.access_token || obj.accessToken || nested?.access_token || nested?.accessToken;
  const refresh =
    obj.refresh_token || obj.refreshToken || nested?.refresh_token || nested?.refreshToken;
  const exp = parseExpiresAtSec(
    obj.expires_at ?? obj.expiresAt ?? nested?.expires_at ?? nested?.expiresAt
  );

  const hasAccess = !!access;
  const hasRefresh = !!refresh;
  const opaqueSession = !hasAccess && !hasRefresh && Object.keys(obj).length > 0;

  if (!hasAccess && !hasRefresh) {
    if (Object.keys(obj).length === 0) {
      return {
        hasAccess: false,
        hasRefresh: false,
        expiresAtSec: null,
        secondsLeft: null,
        freshness: "no_token",
        opaqueSession: false,
      };
    }
    return {
      hasAccess: false,
      hasRefresh: false,
      expiresAtSec: exp,
      secondsLeft: exp != null ? exp - nowSec : null,
      freshness:
        exp == null ? "unknown" : exp - nowSec >= leadSec ? "fresh" : "expired",
      opaqueSession: true,
    };
  }

  if (exp == null) {
    return {
      hasAccess,
      hasRefresh,
      expiresAtSec: null,
      secondsLeft: null,
      freshness: hasAccess ? "unknown" : "no_token",
      opaqueSession: false,
    };
  }

  const secondsLeft = exp - nowSec;
  return {
    hasAccess,
    hasRefresh,
    expiresAtSec: exp,
    secondsLeft,
    freshness: secondsLeft >= leadSec ? "fresh" : "expired",
    opaqueSession: false,
  };
}

function isTruthyEnabled(enabled: boolean | number | null | undefined): boolean {
  return enabled === true || enabled === 1;
}

/**
 * Offline classification for a DB account row.
 * Does not call upstream — refreshable expired access is still "usable".
 */
export function classifyOfflineAccount(
  row: OfflineAccountInput,
  nowSec = Math.floor(Date.now() / 1000),
  leadSec = 45 * 60
): OfflineAccountClass {
  const status = (row.status || "unknown").trim() || "unknown";
  const enabled = isTruthyEnabled(row.enabled);
  const dbActive = enabled && status === "active";
  const tok = inspectTokens(row.tokens, nowSec, leadSec);
  const revokedLooking = isDeadErrorMessage(row.errorMessage);
  const errorStatus = status === "error";

  let usable = false;
  let refreshable = false;

  if (dbActive && !revokedLooking) {
    if (tok.freshness === "fresh") {
      usable = true;
    } else if (tok.freshness === "expired" && tok.hasRefresh) {
      usable = true;
      refreshable = true;
    } else if (tok.freshness === "unknown") {
      if (tok.hasAccess || tok.hasRefresh || tok.opaqueSession) {
        usable = true;
      }
    }
  }

  return {
    enabled,
    status,
    dbActive,
    freshness: tok.freshness,
    hasAccess: tok.hasAccess,
    hasRefresh: tok.hasRefresh,
    secondsLeft: tok.secondsLeft,
    revokedLooking,
    errorStatus,
    usable,
    zombieActive: dbActive && !usable,
    refreshable,
  };
}
