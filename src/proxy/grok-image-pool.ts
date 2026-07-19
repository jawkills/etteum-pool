import { applyAccountAttemptResult } from "./account-attempt";
import { pool } from "./pool";
import { providers } from "./providers/registry";
import type { GrokProvider } from "./providers/grok";
import type { GrokCliImageResult } from "./providers/grok/image";

export type GrokCliImagePoolOpts = {
  mode: "generate" | "edit";
  prompt: string;
  n: number;
  model: string;
  images?: string[];
  maxAttempts?: number;
};

export type GrokCliImagePoolOutcome = {
  result: GrokCliImageResult;
  accountId?: number;
  accountEmail?: string;
  durationMs: number;
};

/**
 * Shared pool loop for Grok free image generate/edit.
 * Used by /v1/images/* and Image Studio so retry/quota policy stays one place.
 * Account mark* side-effects go through applyAccountAttemptResult (same as chat router).
 */
export async function runGrokCliImagePool(
  opts: GrokCliImagePoolOpts
): Promise<GrokCliImagePoolOutcome> {
  const provider = providers["grok"] as GrokProvider;
  if (!provider?.imageRequest) {
    return {
      result: { success: false, error: "Grok image provider unavailable" },
      durationMs: 0,
    };
  }

  const maxAttempts = opts.maxAttempts ?? Math.max(1, provider.maxAccountRetries ?? 3);
  let lastError = "No active grok accounts";
  const started = Date.now();
  const images = (opts.images || []).filter(Boolean);

  if (opts.mode === "edit" && images.length === 0) {
    return {
      result: { success: false, error: "image is required" },
      durationMs: 0,
    };
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const account = await pool.getNextAccount("grok");
    if (!account) break;

    pool.trackRequestStart(account.id);
    try {
      const result = await provider.imageRequest(account, {
        prompt: opts.prompt,
        n: opts.n,
        model: opts.model,
        images: opts.mode === "edit" ? images : undefined,
      });

      // Image success requires at least one b64 payload.
      const attemptResult =
        result.success && result.imagesB64?.length
          ? result
          : {
              ...result,
              success: false,
              error: result.error || "Image request failed",
            };

      const disposition = await applyAccountAttemptResult(account.id, attemptResult, {
        // Image path: non-flagged failures stay transient (do not permanently poison).
        permanentOnGenericFailure: false,
      });

      if (disposition === "success") {
        return {
          result,
          accountId: account.id,
          accountEmail: account.email,
          durationMs: Date.now() - started,
        };
      }

      lastError = attemptResult.error || "Image request failed";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await applyAccountAttemptResult(
        account.id,
        { success: false, error: lastError },
        { permanentOnGenericFailure: false }
      );
    } finally {
      pool.trackRequestEnd(account.id);
    }
  }

  return {
    result: { success: false, error: lastError },
    durationMs: Date.now() - started,
  };
}
