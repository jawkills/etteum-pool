/**
 * Request log persistence — single source of truth for writing request_logs,
 * upserting usage_summary, periodic pruning, and broadcasting request_log
 * events. Extracted from proxy/index.ts so image routes (and other callers)
 * can log without circular imports through the Hono router.
 *
 * Public surface (recordRequest, insertRequestLog, trackUsageAndPrune,
 * finalizeRequestLog, pruneRequestLogs) covers every legitimate caller.
 * The internal upsertUsageSummary / requestCounter are not exported — if you
 * find yourself reaching for them, extend the public API instead.
 */

import { db } from "../db/index";
import { requestLogs, type NewRequestLog } from "../db/schema";
import { broadcast } from "../ws/index";
import { sql, eq } from "drizzle-orm";

const MAX_REQUEST_LOGS = 50;

interface UsageSummaryInput {
  provider: string;
  model: string;
  status: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  creditsUsed: number;
  durationMs: number;
}

/** Upsert a request's stats into the usage_summary table (hourly bucket) */
async function upsertUsageSummary(entry: UsageSummaryInput) {
  try {
    const bucket = new Date();
    bucket.setMinutes(0, 0, 0); // truncate to hour

    await db.run(sql`
      INSERT INTO usage_summary (bucket, provider, model, total_requests, success_requests, error_requests, prompt_tokens, completion_tokens, total_tokens, credits_used, total_duration_ms)
      VALUES (${bucket.toISOString()}, ${entry.provider || "unknown"}, ${entry.model || "unknown"}, 1,
        ${entry.status === "success" ? 1 : 0}, ${entry.status === "error" ? 1 : 0},
        ${entry.promptTokens || 0}, ${entry.completionTokens || 0}, ${entry.totalTokens || 0},
        ${entry.creditsUsed || 0}, ${entry.durationMs || 0})
      ON CONFLICT (bucket, provider, model) DO UPDATE SET
        total_requests = usage_summary.total_requests + excluded.total_requests,
        success_requests = usage_summary.success_requests + excluded.success_requests,
        error_requests = usage_summary.error_requests + excluded.error_requests,
        prompt_tokens = usage_summary.prompt_tokens + excluded.prompt_tokens,
        completion_tokens = usage_summary.completion_tokens + excluded.completion_tokens,
        total_tokens = usage_summary.total_tokens + excluded.total_tokens,
        credits_used = usage_summary.credits_used + excluded.credits_used,
        total_duration_ms = usage_summary.total_duration_ms + excluded.total_duration_ms
    `);
  } catch (err) {
    console.error("[Proxy] Failed to upsert usage_summary:", err);
  }
}

/** Prune request_logs to keep only the most recent MAX_REQUEST_LOGS rows */
export async function pruneRequestLogs() {
  try {
    await db.run(sql`
      DELETE FROM request_logs WHERE id NOT IN (
        SELECT id FROM request_logs ORDER BY created_at DESC LIMIT ${MAX_REQUEST_LOGS}
      )
    `);
  } catch (err) {
    console.error("[Proxy] Failed to prune request_logs:", err);
  }
}

// Prune every 10 requests to avoid running DELETE on every single insert.
let requestCounter = 0;

/**
 * Update usage_summary for this request and run periodic prune. Used by both
 * the insert path (recordRequest/insertRequestLog) and the update path
 * (finalizeRequestLog) so the counter stays in one place.
 */
function trackUsageAndPrune(usage: UsageSummaryInput) {
  void upsertUsageSummary(usage);
  if (++requestCounter % 10 === 0) void pruneRequestLogs();
}

/** Insert a request_logs row, then update usage_summary + periodic prune. */
async function insertWithUsage(
  entry: NewRequestLog,
): Promise<{ id: number; createdAt: Date } | null> {
  const [created] = await db.insert(requestLogs).values(entry).returning({
    id: requestLogs.id,
    createdAt: requestLogs.createdAt,
  });

  trackUsageAndPrune({
    provider: entry.provider || "unknown",
    model: entry.model || "unknown",
    status: entry.status,
    promptTokens: entry.promptTokens || 0,
    completionTokens: entry.completionTokens || 0,
    totalTokens: entry.totalTokens || 0,
    creditsUsed: entry.creditsUsed || 0,
    durationMs: entry.durationMs || 0,
  });
  return created ? { id: created.id, createdAt: created.createdAt } : null;
}

/**
 * Canonical request_logs writer for non-stream success.
 *
 * Inserts the row, updates usage_summary, runs periodic prune, and emits the
 * `request_log` broadcast. Returns the created row (id/createdAt) so callers
 * that need the id (e.g. for streaming telemetry) can use it.
 *
 * Swallows and logs DB errors internally — never throws to the caller.
 */
export async function recordRequest(
  entry: NewRequestLog,
): Promise<{ id: number; createdAt: Date } | null> {
  try {
    const created = await insertWithUsage(entry);
    broadcast({
      type: "request_log",
      data: { ...entry, id: created?.id, email: entry.accountEmail, createdAt: new Date().toISOString() },
    });
    return created;
  } catch (err) {
    console.error("[Proxy] Failed to record request:", err);
    return null;
  }
}

/**
 * Insert a request_logs row and update usage_summary, but DON'T broadcast.
 * Use this when the caller manages its own broadcast (e.g. the streaming path
 * needs `request_started` before completion, with different shape/timing).
 */
export async function insertRequestLog(
  entry: NewRequestLog,
): Promise<{ id: number; createdAt: Date } | null> {
  try {
    return await insertWithUsage(entry);
  } catch (err) {
    console.error("[Proxy] Failed to insert request log:", err);
    return null;
  }
}

/**
 * Update an existing request_logs row (streaming finalizer) and update
 * usage_summary + periodic prune. Does not broadcast — the streaming path
 * emits its own `request_log` event with stream-specific shape.
 */
export async function finalizeRequestLog(
  logId: number,
  patch: {
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    creditsUsed: number;
    durationMs: number;
    accountQuotaAfter: number;
  },
) {
  await db
    .update(requestLogs)
    .set({
      promptTokens: patch.promptTokens,
      completionTokens: patch.completionTokens,
      totalTokens: patch.totalTokens,
      creditsUsed: patch.creditsUsed,
      durationMs: patch.durationMs,
      accountQuotaAfter: patch.accountQuotaAfter,
    })
    .where(eq(requestLogs.id, logId));

  trackUsageAndPrune({
    provider: patch.provider || "unknown",
    model: patch.model || "unknown",
    status: "success",
    promptTokens: patch.promptTokens,
    completionTokens: patch.completionTokens,
    totalTokens: patch.totalTokens,
    creditsUsed: patch.creditsUsed,
    durationMs: patch.durationMs,
  });
}
