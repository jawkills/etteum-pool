/**
 * Shared pool side-effects after a provider attempt.
 * Keeps chat router and image pool mark* policy from drifting.
 */

import { pool } from "./pool";

/** Minimal flags both chat ProviderResult and image results expose. */
export type AccountAttemptResult = {
  success: boolean;
  tokens?: unknown;
  rateLimited?: boolean;
  quotaExhausted?: boolean;
  deadAccount?: boolean;
  error?: string;
};

export type AccountAttemptDisposition =
  | "success"
  | "rate_limited"
  | "exhausted"
  | "dead"
  | "transient"
  | "error";

export type ApplyAccountAttemptOpts = {
  /** When true (default), successful attempts call pool.markUsed. */
  markUsedOnSuccess?: boolean;
  /**
   * When true, non-flagged failures use markError instead of markTransientFailure.
   * Chat router uses this for permanent-looking generic errors.
   * Image pool prefers transient (default false).
   */
  permanentOnGenericFailure?: boolean;
  /**
   * Optional predicate: when permanentOnGenericFailure is true, return true
   * if the error should stay transient (network/timeout).
   */
  isTransientError?: (message: string) => boolean;
};

/**
 * Persist tokens (if any) and mark the account based on result flags.
 * Caller still owns: account selection, trackRequestStart/End, retries, refresh.
 */
export async function applyAccountAttemptResult(
  accountId: number,
  result: AccountAttemptResult,
  opts: ApplyAccountAttemptOpts = {}
): Promise<AccountAttemptDisposition> {
  const markUsedOnSuccess = opts.markUsedOnSuccess !== false;

  if (result.tokens) {
    await pool.updateTokens(accountId, result.tokens);
  }

  if (result.success) {
    if (markUsedOnSuccess) {
      await pool.markUsed(accountId);
    }
    return "success";
  }

  const err = result.error || "Unknown error";

  if (result.rateLimited) {
    // Temporary — do not poison the account.
    return "rate_limited";
  }

  if (result.quotaExhausted) {
    await pool.markExhausted(accountId);
    return "exhausted";
  }

  if (result.deadAccount) {
    await pool.markError(accountId, err);
    return "dead";
  }

  if (opts.permanentOnGenericFailure) {
    const transient = opts.isTransientError?.(err) ?? false;
    if (transient) {
      await pool.markTransientFailure(accountId, err);
      return "transient";
    }
    await pool.markError(accountId, err);
    return "error";
  }

  await pool.markTransientFailure(accountId, err);
  return "transient";
}
