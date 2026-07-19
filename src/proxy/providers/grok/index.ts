/**
 * Grok provider — session policy + catalog + public barrel.
 * Wire HTTP lives in grok-cli-wire.ts; pure helpers in sibling modules.
 */

import {
  BaseProvider,
  type ChatCompletionRequest,
  type ModelInfo,
  type ProviderResult,
} from "../base";
import type { Account } from "../../../db/schema";
import { isPermanentRevocation } from "../../account-health";
import { parseExpiresAtSec } from "../../account-health";
import {
  sessionProveToHealth,
  type ProveMode,
  type SessionProveResult,
} from "../../session-prove-map";
import { getCachedGrokCliRuntimeSettings } from "./settings";

// --- pure modules (re-exported for stable public API) ---
export {
  GROK_CLI_TOKEN_LIMIT,
  GROK_CLI_UPSTREAM_BASE,
  GROK_CLI_TOKEN_URL,
  GROK_CLI_CLIENT_ID,
  GROK_CLI_CLIENT_VERSION,
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_TOKEN_AUTH_VALUE,
  GROK_CLI_REFRESH_LEAD_SEC,
  GROK_CLI_IMAGE_TIMEOUT_MS,
  GROK_CLI_CREDIT_SOFT_ERROR,
} from "./constants";
export { type GrokCliTokens, type GrokCliNormalized, normalizeGrokCliCpa } from "./cpa";
export {
  type GrokEffort,
  GROK_CATALOG_IDS,
  GROK_UPSTREAM_MODEL,
  parseGrokModelId,
  resolveGrokUpstreamModel,
  grokOwnsModel,
  GROK_CLI_CATALOG_IDS,
  parseGrokCliModelId,
  resolveGrokCliUpstreamModel,
  grokCliOwnsModel,
} from "./models";
export {
  type GrokCliErrorKind,
  type GrokCliRateLimitSnapshot,
  type GrokAuthClass,
  classifyGrokCliError,
  parseGrokCliRateLimitHeaders,
  parseGrokCliExhaustedBody,
  quotaFromGrokCliCenterSignals,
  isGrokCliDeadError,
  isGrokCliPermanentRevocation,
  classifyGrokAuthFailure,
  formatGrokAuthFailure,
  formatGrokCliDeadError,
} from "./errors";
export {
  grokCliContentBlocksToText,
  normalizeGrokCliMessagesForOpenAI,
} from "./messages";
export type {
  GrokCliImageRequestOpts,
  GrokCliImageResult,
  GrokCliUsageNormalized,
} from "./image";
export {
  extractGrokCliImageGenerationResults,
  normalizeGrokCliImageRef,
  collectGrokCliImageRefs,
  normalizeGrokCliUsage,
  stripGrokCliDataUrlPrefix,
  emptyGrokCliUsage,
  addGrokCliUsage,
} from "./image";
export { buildGrokHeaders, buildGrokCliHeaders } from "./headers";

import {
  GROK_CLI_TOKEN_LIMIT,
  GROK_CLI_CREDIT_SOFT_ERROR,
} from "./constants";
import { type GrokCliTokens } from "./cpa";
import {
  GROK_CATALOG_IDS,
  grokOwnsModel,
} from "./models";
import {
  classifyGrokCliError,
  formatGrokAuthFailure,
  formatGrokCliDeadError,
} from "./errors";
import type {
  GrokCliImageRequestOpts,
  GrokCliImageResult,
} from "./image";
import {
  grokCliChatCompletion,
  grokCliChatCompletionStream,
  grokCliDoRefresh,
  grokCliFetchQuota,
  grokCliImageRequest,
  readGrokCliTokens,
  type UpstreamPipe,
} from "./wire";

/** Parse expires_at from unix sec/ms or ISO-8601 string. */
export function parseGrokCliExpiresAt(raw: string | number | undefined | null): number | null {
  return parseExpiresAtSec(raw);
}

/** True if access token should be refreshed before calling upstream. */
export function grokCliNeedsProactiveRefresh(
  tokens: GrokCliTokens,
  leadSec: number = getCachedGrokCliRuntimeSettings().refreshLeadSec,
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  const expSec = parseGrokCliExpiresAt(tokens.expires_at);
  if (expSec == null) return false;
  return expSec - nowSec < leadSec;
}

type RefreshResult = { success: boolean; tokens?: string; error?: string };

export class GrokProvider extends BaseProvider {
  name = "grok";
  override nativeFormat: "openai" | "anthropic" = "openai";
  override isFallback = false;

  override get maxAccountRetries(): number {
    return getCachedGrokCliRuntimeSettings().maxAccountRetries;
  }

  private refreshLocks = new Map<number, Promise<RefreshResult>>();

  supportedModels: ModelInfo[] = [
    ...GROK_CATALOG_IDS.map((id) => ({
      id,
      object: "model" as const,
      created: Date.now(),
      owned_by: "grok",
      context_window: 500_000,
      // xAI announcement: grok-4.5 averages ~15,954 output tokens per task;
      // no hard output ceiling is published. Rounded up to a practical 16K
      // budget so the dashboard's "Output" column reflects a realistic value
      // rather than blank.
      max_output: 16_000,
      thinking: true,
      vision: true,
      // xAI docs grok-4.5 lists Function calling as a capability.
      tools: true,
      creditUnit: "token" as const,
      creditRate: 1,
      creditSource: "estimated" as const,
    })),
    {
      id: "grok-image",
      object: "model" as const,
      created: Date.now(),
      owned_by: "grok",
      context_window: 500_000,
      max_output: 4096,
      thinking: false,
      vision: true,
      creditUnit: "image" as const,
      creditRate: 1,
      creditSource: "estimated" as const,
    },
  ];

  override ownsModel(model: string): boolean {
    return grokOwnsModel(model);
  }

  override getModelInfo(model: string): ModelInfo | undefined {
    const m = model.trim().toLowerCase();
    const exact = this.supportedModels.find((item) => item.id.toLowerCase() === m);
    if (exact) return exact;
    if (m === "grok-4.5-max") {
      return this.supportedModels.find((item) => item.id === "grok-4.5-xhigh");
    }
    return super.getModelInfo(model);
  }

  private getTokens(account: Account): GrokCliTokens | null {
    return readGrokCliTokens(account);
  }

  private fetchBound = (
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> => this.fetchWithTimeout(url, init, timeoutMs);

  /**
   * Single session-prep policy for hot path, prove(if-needed), and force-refresh.
   */
  private async prepareSession(
    account: Account,
    mode: "hot" | "if-needed" | "force"
  ): Promise<
    | { ok: true; account: Account; tokensJson?: string; refreshed: boolean }
    | {
        ok: false;
        error: string;
        deadAccount: boolean;
        kind: "session_revoked" | "missing_tokens" | "auth_error";
      }
  > {
    if (isPermanentRevocation(account.errorMessage)) {
      return {
        ok: false,
        error: account.errorMessage || formatGrokCliDeadError("refresh token revoked"),
        deadAccount: true,
        kind: "session_revoked",
      };
    }

    const tokens = this.getTokens(account);
    if (!tokens?.access_token) {
      const formatted = formatGrokAuthFailure("No access_token for grok account");
      return {
        ok: false,
        error: formatted.error,
        deadAccount: formatted.deadAccount,
        kind: formatted.kind === "missing" ? "missing_tokens" : "auth_error",
      };
    }

    const shouldRefresh =
      mode === "force" ||
      grokCliNeedsProactiveRefresh(tokens) ||
      (mode === "if-needed" &&
        (account.status === "error" || account.status === "pending"));

    if (!shouldRefresh) {
      return { ok: true, account, refreshed: false };
    }

    if (!tokens.refresh_token) {
      return {
        ok: false,
        error:
          mode === "hot"
            ? "No refresh_token"
            : "No access_token/refresh_token for grok account",
        deadAccount: false,
        kind: "missing_tokens",
      };
    }

    const refreshed = await this.refreshToken(account);
    if (!refreshed.success || !refreshed.tokens) {
      const formatted = formatGrokAuthFailure(refreshed.error || "refresh failed");
      if (formatted.kind === "permanent") {
        return {
          ok: false,
          error: formatted.error,
          deadAccount: true,
          kind: "session_revoked",
        };
      }
      if (formatted.kind === "missing") {
        return {
          ok: false,
          error: formatted.error,
          deadAccount: false,
          kind: "missing_tokens",
        };
      }
      return {
        ok: false,
        error: formatted.error,
        deadAccount: formatted.deadAccount,
        kind: "auth_error",
      };
    }

    return {
      ok: true,
      account: { ...account, tokens: JSON.parse(refreshed.tokens) } as Account,
      tokensJson: refreshed.tokens,
      refreshed: true,
    };
  }

  private async handleAuthFailure(
    working: Account,
    status: number,
    bodyPeek: string
  ): Promise<
    | { kind: "dead"; error: string }
    | { kind: "auth_failed"; error: string; deadAccount: boolean }
    | { kind: "refreshed"; account: Account; tokensJson: string }
  > {
    const kind = classifyGrokCliError(status, bodyPeek);
    if (kind === "dead") {
      return { kind: "dead", error: formatGrokCliDeadError(bodyPeek) };
    }
    const refreshed = await this.refreshToken(working);
    if (refreshed.success && refreshed.tokens) {
      return {
        kind: "refreshed",
        account: { ...working, tokens: JSON.parse(refreshed.tokens) } as Account,
        tokensJson: refreshed.tokens,
      };
    }
    const formatted = formatGrokAuthFailure(refreshed.error || "refresh failed");
    return {
      kind: "auth_failed",
      error: formatted.error,
      deadAccount: formatted.deadAccount,
    };
  }

  private withGrokUpstream: UpstreamPipe = async (account, call) => {
    const session = await this.prepareSession(account, "hot");
    if (!session.ok) {
      return {
        ok: false,
        error: session.error,
        deadAccount: session.deadAccount,
      };
    }

    let working = session.account;
    let tokensJson = session.tokensJson;
    let response = await call(working);

    if (response.status === 401) {
      const peek = await response.clone().text().catch(() => "");
      const auth = await this.handleAuthFailure(working, 401, peek);
      if (auth.kind === "dead") {
        return { ok: false, error: auth.error, deadAccount: true, tokensJson };
      }
      if (auth.kind === "auth_failed") {
        return {
          ok: false,
          error: auth.error,
          deadAccount: auth.deadAccount,
          tokensJson,
        };
      }
      tokensJson = auth.tokensJson;
      working = auth.account;
      response = await call(working);
    }

    return { ok: true, response, account: working, tokensJson };
  };

  async imageRequest(account: Account, opts: GrokCliImageRequestOpts): Promise<GrokCliImageResult> {
    return grokCliImageRequest(this.withGrokUpstream, account, opts, this.fetchBound);
  }

  async imageGenerate(
    account: Account,
    opts: { prompt: string; n?: number; model?: string }
  ): Promise<GrokCliImageResult> {
    return this.imageRequest(account, opts);
  }

  async imageEdit(
    account: Account,
    opts: { prompt: string; images: string[]; n?: number; model?: string }
  ): Promise<GrokCliImageResult> {
    if (!(opts.images || []).filter(Boolean).length) {
      return { success: false, error: "image is required" };
    }
    return this.imageRequest(account, opts);
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    return grokCliChatCompletion(
      this.withGrokUpstream,
      account,
      request,
      this.fetchBound,
      (messages) => this.estimateMessagesTokens(messages),
      () => this.generateId()
    );
  }

  async chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    return grokCliChatCompletionStream(
      this.withGrokUpstream,
      account,
      request,
      this.fetchBound
    );
  }

  async refreshToken(account: Account): Promise<RefreshResult> {
    const existing = this.refreshLocks.get(account.id);
    if (existing) return existing;

    const p = grokCliDoRefresh(this.fetchBound, account).finally(() => {
      this.refreshLocks.delete(account.id);
    });
    this.refreshLocks.set(account.id, p);
    return p;
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!(tokens?.access_token && tokens?.refresh_token);
  }

  async proveSession(account: Account, mode: ProveMode): Promise<SessionProveResult> {
    const prepMode = mode === "force-refresh" ? "force" : "if-needed";
    const session = await this.prepareSession(account, prepMode);
    if (!session.ok) {
      const healthKind =
        session.kind === "session_revoked"
          ? "session_expired"
          : session.kind === "missing_tokens"
            ? "missing_tokens"
            : "auth_error";
      return {
        ok: false,
        kind: session.kind,
        error: session.error,
        refreshed: false,
        healthKind,
      };
    }

    if (!session.refreshed) {
      return {
        ok: true,
        kind: "healthy",
        refreshed: false,
        healthKind: "healthy",
        message: "Access token within refresh lead window",
      };
    }

    let parsed: unknown = session.tokensJson;
    if (session.tokensJson) {
      try {
        parsed = JSON.parse(session.tokensJson);
      } catch {
        /* keep string */
      }
    }
    return {
      ok: true,
      kind: "healthy",
      tokens: parsed,
      refreshed: true,
      healthKind: "healthy",
      message: "Refresh token valid; access renewed",
    };
  }

  override async healthCheck(account: Account): Promise<import("./base").ProviderHealthResult> {
    const proved = await this.proveSession(account, "if-needed");
    if (!proved.ok) {
      return sessionProveToHealth(proved);
    }

    const working = proved.tokens
      ? ({ ...account, tokens: proved.tokens } as Account)
      : account;
    const quota = await this.fetchQuota(working);
    const q = quota.quota;
    const exhausted =
      quota.exhausted === true ||
      (q != null && Number(q.remaining) <= 0 && Number(q.limit) > 0);

    if (exhausted) {
      return {
        kind: "exhausted",
        success: true,
        tokens: proved.tokens,
        message: quota.error || GROK_CLI_CREDIT_SOFT_ERROR,
        quota: q
          ? {
              limit: q.limit,
              remaining: 0,
              used: q.used ?? Math.max(0, q.limit),
              resetAt: q.resetAt ?? null,
              source: q.source || "grok.fetchQuota",
            }
          : {
              limit: GROK_CLI_TOKEN_LIMIT,
              remaining: 0,
              used: GROK_CLI_TOKEN_LIMIT,
              resetAt: null,
              source: "upstream-exhausted",
            },
      };
    }

    return {
      kind: "healthy",
      success: true,
      tokens: proved.tokens,
      message: proved.message,
      quota: q
        ? {
            limit: q.limit,
            remaining: q.remaining,
            used: q.used,
            resetAt: q.resetAt ?? null,
            source: q.source || "grok.fetchQuota",
          }
        : undefined,
    };
  }

  async fetchQuota(account: Account) {
    return grokCliFetchQuota(this.fetchBound, account);
  }
}

export const grokProvider = new GrokProvider();

/** @deprecated use grokProvider */
export const grokCliProvider = grokProvider;
export { GrokProvider as GrokCliProvider };
