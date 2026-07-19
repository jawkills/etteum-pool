import type { ChatCompletionRequest, ProviderResult } from "./providers/base";
import { providers, getAllModels, type ProviderName } from "./providers/registry";
import { isNonAccountRequestError, isTransientError } from "./errors";
import { applyPudidilFilters } from "./filters";
import { applyAccountAttemptResult } from "./account-attempt";
import { pool } from "./pool";
import type { Account } from "../db/schema";
import {
  compressRequest,
  getCompressionConfig,
  type CompressionStats,
} from "./compression";

export interface RouteResult {
  result: ProviderResult;
  account: Account;
  provider: ProviderName;
  durationMs: number;
  compressionStats?: CompressionStats;
}

/** Check if a request contains image content blocks */
function requestHasImages(request: ChatCompletionRequest): boolean {
  return request.messages.some((msg) => {
    if (!Array.isArray(msg.content)) return false;
    return (msg.content as any[]).some(
      (block) => block?.type === "image_url" || block?.type === "image"
    );
  });
}

/**
 * Sanitize request by applying pudidil filters to all text content.
 * Strips Claude Code identity, billing headers, and other patterns
 * that trigger content moderation on upstream providers.
 */
function sanitizeRequest(request: ChatCompletionRequest): ChatCompletionRequest {
  const sanitized = { ...request };

  sanitized.messages = request.messages.map((msg) => {
    if (typeof msg.content === "string") {
      return { ...msg, content: applyPudidilFilters(msg.content) };
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: (msg.content as any[]).map((block) => {
          if (block?.type === "text" && typeof block.text === "string") {
            return { ...block, text: applyPudidilFilters(block.text) };
          }
          if (block?.type === "tool_result") {
            if (typeof block.content === "string") {
              return { ...block, content: applyPudidilFilters(block.content) };
            }
            if (Array.isArray(block.content)) {
              return {
                ...block,
                content: block.content.map((inner: any) =>
                  inner?.type === "text" && typeof inner.text === "string"
                    ? { ...inner, text: applyPudidilFilters(inner.text) }
                    : inner
                ),
              };
            }
          }
          return block;
        }),
      };
    }
    return msg;
  });

  if (sanitized.tools) {
    sanitized.tools = request.tools!.map((tool: any) => {
      if (tool?.function?.description) {
        return {
          ...tool,
          function: {
            ...tool.function,
            description: applyPudidilFilters(tool.function.description),
          },
        };
      }
      return tool;
    });
  }

  return sanitized;
}

/**
 * Route a chat completion request to the appropriate provider/account.
 * Implements retry logic with fallback to next account.
 */
export async function routeRequest(
  request: ChatCompletionRequest,
  stream: boolean
): Promise<RouteResult> {
  // Apply content filters to strip Claude Code identity, billing headers, etc.
  const sanitizedRequest = sanitizeRequest(request);

  const hasImages = requestHasImages(sanitizedRequest);
  const providerName = pool.getProviderForModel(sanitizedRequest.model);
  if (!providerName) {
    throw new Error(`No provider found for model: ${sanitizedRequest.model}`);
  }

  // Apply compression pipeline (RTK + DCP + Caveman + image dedupe + cache markers).
  // Failures here are non-fatal — fall back to the sanitized request and move on.
  let compressedRequest = sanitizedRequest;
  let compressionStats: CompressionStats | undefined;
  try {
    const cfg = await getCompressionConfig();
    const out = compressRequest(sanitizedRequest, cfg, providerName);
    compressedRequest = out.request;
    compressionStats = out.stats;
  } catch (err) {
    console.error("[Compression] Failed, passing request through unchanged:", err);
  }

  const provider = providers[providerName];
  if (!provider) {
    throw new Error(`Provider not configured: ${providerName}`);
  }

  // Reject image requests for models that don't support vision
  if (hasImages) {
    const modelInfo = provider.getModelInfo(sanitizedRequest.model);
    if (modelInfo && !modelInfo.vision) {
      throw new Error(
        `Model "${sanitizedRequest.model}" does not support image/vision inputs. Use a vision-capable model instead.`
      );
    }
  }

  const maxRetries = Math.max(1, provider.maxAccountRetries ?? 3);
  let lastError = "";
  const attemptedByokAccountIds = new Set<number>();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // BYOK uses prefix-based account lookup (not the generic pool),
    // so it can also find error-status accounts and retry them.
    const account = providerName === "byok"
      ? (await pool.getAccountForModel(compressedRequest.model, {
          excludeAccountIds: attemptedByokAccountIds,
        }))?.account ?? null
      : await pool.getNextAccount(providerName);
    if (!account) {
      throw new Error(
        `No active accounts available for provider: ${providerName}`
      );
    }
    if (providerName === "byok") attemptedByokAccountIds.add(account.id);

    const startTime = Date.now();
    let tracked = false;

    try {
      pool.trackRequestStart(account.id);
      tracked = true;
      const result = stream
        ? await provider.chatCompletionStream(account, compressedRequest)
        : await provider.chatCompletion(account, compressedRequest);

      const durationMs = Date.now() - startTime;

      // Client-side model errors should not poison accounts. A wrong model ID
      // is a bad request, not an account/session failure, so stop retrying and
      // let the API layer return an invalid_model response.
      if (!result.success && isNonAccountRequestError(result.error)) {
        pool.trackRequestEnd(account.id);
        tracked = false;
        throw new Error(result.error || `Invalid model: ${compressedRequest.model}`);
      }

      // Chat-router-only: optional same-account refresh for legacy 401/expired
      // strings when the provider did not already set deadAccount/rateLimited.
      // Grok handles refresh inside the provider; this path still serves others.
      if (
        !result.success &&
        !result.rateLimited &&
        !result.quotaExhausted &&
        !result.deadAccount &&
        (result.error?.includes("expired") || result.error?.includes("401"))
      ) {
        pool.trackRequestEnd(account.id);
        tracked = false;
        const refreshResult = await provider.refreshToken(account);
        if (refreshResult.success && refreshResult.tokens) {
          let parsedTokens: unknown;
          try {
            parsedTokens = JSON.parse(refreshResult.tokens);
          } catch {
            parsedTokens = refreshResult.tokens;
          }
          await pool.updateTokens(account.id, parsedTokens);
          pool.trackRequestStart(account.id);
          tracked = true;
          const retryResult = stream
            ? await provider.chatCompletionStream(account, compressedRequest)
            : await provider.chatCompletion(account, compressedRequest);

          if (retryResult.success) {
            await applyAccountAttemptResult(account.id, retryResult, {
              permanentOnGenericFailure: true,
              isTransientError,
            });
            return {
              result: retryResult,
              account,
              provider: providerName,
              durationMs: Date.now() - startTime,
              compressionStats,
            };
          }
          pool.trackRequestEnd(account.id);
          tracked = false;
          await applyAccountAttemptResult(account.id, retryResult, {
            permanentOnGenericFailure: true,
            isTransientError,
          });
          lastError = retryResult.error || "Auth failed";
          continue;
        }
        await applyAccountAttemptResult(
          account.id,
          { success: false, error: result.error || "Auth failed" },
          { permanentOnGenericFailure: false }
        );
        lastError = result.error || "Auth failed";
        continue;
      }

      const disposition = await applyAccountAttemptResult(account.id, result, {
        permanentOnGenericFailure: true,
        isTransientError,
      });

      if (disposition === "success") {
        return { result, account, provider: providerName, durationMs, compressionStats };
      }

      pool.trackRequestEnd(account.id);
      tracked = false;
      lastError =
        result.error ||
        (disposition === "rate_limited"
          ? "Rate limited"
          : disposition === "exhausted"
            ? "Quota exhausted"
            : disposition === "dead"
              ? "Account dead"
              : "Unknown error");
    } catch (error) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      if (tracked) {
        pool.trackRequestEnd(account.id);
        tracked = false;
      }
      if (isNonAccountRequestError(errMsg)) {
        throw error;
      }
      if (errMsg.includes("expired") || errMsg.includes("401")) {
        await pool.markTransientFailure(account.id, errMsg);
      } else if (isTransientError(errMsg)) {
        await pool.markTransientFailure(account.id, errMsg);
      } else {
        await pool.markError(account.id, errMsg);
      }
      lastError = errMsg;
    }
  }

  throw new Error(
    `All accounts failed for ${providerName}. Last error: ${lastError}`
  );
}

// Re-exported from the provider registry (single source of truth). Kept as
// named exports here so existing import sites (proxy/index.ts, api/stats.ts,
// auth/runner.ts, api/image-studio.ts, auth/warmup-runner.ts) stay unchanged.
export { providers, getAllModels, type ProviderName };
