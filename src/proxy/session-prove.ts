/**
 * Shared session prove / OAuth refresh disposition.
 * One path for healthCheck (if-needed) and POST refresh-token (force).
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { accounts, type Account } from "../db/schema";
import { pool, type ProviderName } from "./pool";
import { providers } from "./providers/registry";
import {
  isMissingCredentialMessage,
  isPermanentRevocation,
} from "./account-health";
import type { ProviderHealthResult } from "./providers/base";
import {
  sessionProveToHealth,
  type ProveMode,
  type SessionProveKind,
  type SessionProveResult,
} from "./session-prove-map";

export type { ProveMode, SessionProveKind, SessionProveResult };
export { sessionProveToHealth };

function parseTokensPayload(tokens: string | undefined): unknown | undefined {
  if (!tokens) return undefined;
  try {
    return JSON.parse(tokens);
  } catch {
    return tokens;
  }
}

type ProveCapable = {
  proveSession?: (account: Account, mode: ProveMode) => Promise<SessionProveResult>;
  refreshToken: (account: Account) => Promise<{ success: boolean; tokens?: string; error?: string }>;
  healthCheck: (account: Account) => Promise<ProviderHealthResult>;
};

/**
 * Prove account session is usable.
 * - if-needed: provider may skip refresh when access still fresh
 * - force-refresh: always call refreshToken (UI "Refresh token")
 */
export async function proveAccountSession(
  account: Account,
  mode: ProveMode
): Promise<SessionProveResult> {
  if (isPermanentRevocation(account.errorMessage)) {
    return {
      ok: false,
      kind: "session_revoked",
      error: account.errorMessage || "Account session permanently revoked",
      refreshed: false,
      healthKind: "session_expired",
    };
  }

  // Missing-credential accounts fall through to provider.proveSession, which
  // returns kind="missing_tokens" — no special case needed here.

  const provider = providers[account.provider as keyof typeof providers] as
    | ProveCapable
    | undefined;
  if (!provider) {
    return {
      ok: false,
      kind: "unsupported",
      error: `Provider not configured: ${account.provider}`,
      refreshed: false,
      healthKind: "unsupported",
    };
  }

  // Prefer provider-specific prove (Grok CLI OAuth semantics).
  if (typeof provider.proveSession === "function") {
    return provider.proveSession(account, mode);
  }

  if (mode === "if-needed") {
    const health = await provider.healthCheck(account);
    if (health.kind === "healthy" || health.kind === "exhausted") {
      return {
        ok: true,
        kind: "healthy",
        tokens: health.tokens,
        message: health.message,
        refreshed: Boolean(health.tokens),
        healthKind: health.kind === "exhausted" ? "exhausted" : "healthy",
      };
    }
    if (health.kind === "session_expired" || isPermanentRevocation(health.error)) {
      return {
        ok: false,
        kind: "session_revoked",
        error: health.error,
        refreshed: false,
        healthKind: "session_expired",
      };
    }
    if (health.kind === "missing_tokens") {
      return {
        ok: false,
        kind: "missing_tokens",
        error: health.error,
        refreshed: false,
        healthKind: "missing_tokens",
      };
    }
    return {
      ok: false,
      kind: "auth_error",
      error: health.error || health.message || "health check failed",
      refreshed: false,
      healthKind: health.kind,
    };
  }

  // Generic force refresh
  if (!provider.refreshToken) {
    return {
      ok: false,
      kind: "unsupported",
      error: `Provider ${account.provider} does not support refreshToken`,
      refreshed: false,
      healthKind: "unsupported",
    };
  }

  const refreshed = await provider.refreshToken(account);
  if (!refreshed.success || !refreshed.tokens) {
    const err = refreshed.error || "refresh failed";
    if (isPermanentRevocation(err)) {
      return {
        ok: false,
        kind: "session_revoked",
        error: err,
        refreshed: false,
        healthKind: "session_expired",
      };
    }
    if (isMissingCredentialMessage(err)) {
      return {
        ok: false,
        kind: "missing_tokens",
        error: err,
        refreshed: false,
        healthKind: "missing_tokens",
      };
    }
    return {
      ok: false,
      kind: "auth_error",
      error: err,
      refreshed: false,
      healthKind: "auth_error",
    };
  }

  return {
    ok: true,
    kind: "healthy",
    tokens: parseTokensPayload(refreshed.tokens),
    message: "Token refreshed",
    refreshed: true,
    healthKind: "healthy",
  };
}

export type ApplySessionOpts = {
  /**
   * When true (default), successful prove clears errorMessage and sets active
   * only if previous status was error|pending (never exhausted→active).
   */
  promoteFromError?: boolean;
};

/**
 * Persist prove result. Does NOT markUsed (not a traffic request).
 */
export async function applySessionProveResult(
  account: Account,
  result: SessionProveResult,
  opts: ApplySessionOpts = {}
): Promise<{ status: string }> {
  const promoteFromError = opts.promoteFromError !== false;

  if (result.ok) {
    if (result.tokens !== undefined) {
      await pool.updateTokens(account.id, result.tokens);
    }
    const canPromote =
      promoteFromError &&
      account.enabled !== false &&
      (account.status === "error" || account.status === "pending");

    if (canPromote) {
      await db
        .update(accounts)
        .set({
          status: "active",
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, account.id));
      pool.invalidate(account.provider as ProviderName);
      return { status: "active" };
    }

    if (result.tokens !== undefined && account.errorMessage && !isPermanentRevocation(account.errorMessage)) {
      // Cleared soft auth noise only when we actually refreshed tokens.
      await db
        .update(accounts)
        .set({ errorMessage: null, updatedAt: new Date() })
        .where(eq(accounts.id, account.id));
    }
    pool.invalidate(account.provider as ProviderName);
    return { status: account.status };
  }

  if (result.kind === "session_revoked") {
    await pool.markError(account.id, result.error || "Account session permanently revoked");
    return { status: "error" };
  }

  if (result.kind === "missing_tokens") {
    await pool.markError(account.id, result.error || "Missing tokens");
    return { status: "error" };
  }

  if (result.kind === "unsupported") {
    return { status: account.status };
  }

  await pool.markTransientFailure(account.id, result.error || "Auth refresh failed");
  return { status: account.status };
}
