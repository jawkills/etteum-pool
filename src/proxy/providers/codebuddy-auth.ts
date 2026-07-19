/**
 * Shared CodeBuddy (global + China) auth/credit helpers.
 *
 * Sourced from community rotator RE + npm @tencent-ai/codebuddy-code@2.124.0:
 * - X-User-Id prefers JWT `sub` (email as X-User-Id breaks some paths)
 * - Credit death: HTTP 429 + body "Credits exhausted" + SignLicense codes 11216/11212/12005
 * - Do not hardcode stale X-IDE-Version (2.121.1); wire IDE headers are optional/out of scope here
 */

/** SignLicense / trial codes still present in CLI 2.124.0 headless bundle. */
export const CODEBUDDY_CREDIT_CODES = new Set([11216, 11212, 12005]);

export const CODEBUDDY_CREDIT_SOFT_ERROR = "CodeBuddy credits exhausted";

/**
 * Prefer Keycloak `sub` UUID from a JWT Bearer token.
 * Opaque `ck_...` API keys are not JWTs — returns undefined (omit header).
 */
export function resolveCodeBuddyUserId(bearer: string | undefined | null): string | undefined {
  if (!bearer) return undefined;
  const token = bearer.replace(/^Bearer\s+/i, "").trim();
  if (!token || token.split(".").length < 2) return undefined;

  try {
    const part = token.split(".")[1]!;
    const pad = "=".repeat((4 - (part.length % 4)) % 4);
    // base64url → standard base64
    const b64 = (part + pad).replace(/-/g, "+").replace(/_/g, "/");
    const json =
      typeof Buffer !== "undefined"
        ? Buffer.from(b64, "base64").toString("utf8")
        : atob(b64);
    const payload = JSON.parse(json) as { sub?: unknown };
    const sub = payload.sub != null ? String(payload.sub) : "";
    if (sub.length > 8) return sub;
  } catch {
    // not a JWT — omit
  }
  return undefined;
}

/** Attach X-User-Id when resolvable; never invent email. */
export function applyCodeBuddyUserIdHeader(
  headers: Record<string, string>,
  bearer: string | undefined | null,
): void {
  const uid = resolveCodeBuddyUserId(bearer);
  if (uid) headers["X-User-Id"] = uid;
}

/**
 * Detect credit/auth death that should rotate the account (quotaExhausted).
 * Port of rotator trampoline bodyLooksExhausted + statusLooksCreditOrAuthDead,
 * tightened so plain model errors are not treated as credit death.
 */
export function isCodeBuddyCreditDeath(status: number, body = ""): boolean {
  const text = body || "";

  // Live SaaS: 429 is usually "Credits exhausted" (not only TrialExpired 11216).
  // 402 payment-required treated the same. 401 alone is NOT credit death unless body says so.
  if (status === 429 || status === 402) return true;

  if (!text) return false;

  if (/credits?\s*exhausted/i.test(text)) return true;
  if (/purchase add-on packs/i.test(text)) return true;
  if (/get more credits/i.test(text) && /codebuddy\.ai\/profile\/usage/i.test(text)) return true;
  if (/insufficient\s+credits?/i.test(text)) return true;
  if (/"code"\s*:\s*11216\b/.test(text)) return true;
  if (/"code"\s*:\s*11212\b/.test(text) || /"code"\s*:\s*12005\b/.test(text)) return true;
  if (text.includes("11216") && /TrialExpired|trial expired|credit|quota|capacity/i.test(text)) {
    return true;
  }

  try {
    const j = JSON.parse(text) as {
      code?: unknown;
      msg?: unknown;
      message?: unknown;
      error?: unknown;
      extError?: unknown;
    };
    if (j && CODEBUDDY_CREDIT_CODES.has(Number(j.code))) return true;
    const msg = String(j.msg || j.message || j.error || "");
    if (/credits?\s*exhausted|add-on packs|insufficient\s+credits?/i.test(msg)) return true;
    if (j.extError && /credit/i.test(JSON.stringify(j.extError))) return true;
  } catch {
    // not JSON
  }

  // 401/403 only when body explicitly indicates credit/license death
  if (
    (status === 401 || status === 403) &&
    /credits?\s*exhausted|TrialExpired|11216|insufficient\s+credits?/i.test(text)
  ) {
    return true;
  }

  return false;
}

/**
 * Classify a non-OK CodeBuddy chat/billing response into a ProviderResult-shaped
 * failure. Soft error string — do not dump multi-line upstream bodies for credit death.
 */
export function classifyCodeBuddyHttpFailure(
  status: number,
  body: string,
  label = "CodeBuddy",
): { error: string; quotaExhausted?: boolean; sessionExpired?: boolean } {
  if (isCodeBuddyCreditDeath(status, body)) {
    return { error: CODEBUDDY_CREDIT_SOFT_ERROR, quotaExhausted: true };
  }
  if (status === 401 || status === 403) {
    return {
      error: status === 401 ? `${label} session expired` : `${label} forbidden`,
      sessionExpired: true,
    };
  }
  // Keep a short body peek for debugging, but cap length.
  const peek = (body || "").replace(/\s+/g, " ").trim().slice(0, 240);
  return {
    error: peek
      ? `${label} API error (${status}): ${peek}`
      : `${label} API error (${status})`,
  };
}

/**
 * Parse get-user-resource quota payload.
 * Prefer CapacityRemain sum; treat TotalDosage=0 + empty Accounts as ambiguous
 * (community false-zero thrash fix) — returns null remaining signal via `ambiguous`.
 */
export function parseCodeBuddyResourceQuota(data: unknown): {
  limit: number;
  remaining: number;
  used: number;
  ambiguous?: boolean;
} {
  const root = data as {
    data?: { Response?: { Data?: Record<string, unknown> } };
    code?: number;
  };
  const responseData = root?.data?.Response?.Data || {};
  const totalDosage = Number((responseData as any).TotalDosage ?? 0);
  const resourceAccounts = Array.isArray((responseData as any).Accounts)
    ? ((responseData as any).Accounts as Array<Record<string, unknown>>)
    : [];

  let totalRemain = 0;
  let totalUsed = 0;
  let totalSize = 0;
  let hasRemainField = false;

  for (const acct of resourceAccounts) {
    if (acct.CapacityRemain != null) {
      hasRemainField = true;
      totalRemain += Number(acct.CapacityRemain || 0);
    }
    totalUsed += Number(acct.CapacityUsed || 0);
    totalSize += Number(acct.CapacitySize || 0);
  }

  // Flaky payload: TotalDosage 0 and no account rows — not real zero credits.
  if (
    (totalDosage === 0 || !Number.isFinite(totalDosage)) &&
    resourceAccounts.length === 0
  ) {
    return { limit: 0, remaining: 0, used: 0, ambiguous: true };
  }

  const limit = totalSize || totalDosage || totalRemain + totalUsed;
  const remaining = hasRemainField ? totalRemain : totalDosage > 0 ? totalDosage : totalRemain;
  const used = totalUsed || Math.max(0, limit - remaining);
  return { limit, remaining, used };
}
