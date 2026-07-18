import { Hono } from "hono";
import { routeRequest } from "../proxy/router";
import { pool } from "../proxy/pool";
import { normalizeModelId, resolveModelAlias } from "../proxy/model-mapping";

export const modelsRouter = new Hono();

/**
 * POST /api/models/test — admin smoke test for a pool model id.
 *
 * Uses the same routing path as production (`routeRequest`) but skips
 * request_logs / usage_summary so Requests/Usage stay clean.
 *
 * Side effects from routeRequest (mark exhausted/error on hard failures) are
 * intentional: this is a real connectivity probe.
 *
 * On success, routeRequest leaves in-flight tracking open — callers must
 * release via pool.trackRequestEnd (see handleChatCompletion).
 */
modelsRouter.post("/test", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { model?: unknown };
  const rawModel = typeof body.model === "string" ? body.model.trim() : "";

  if (!rawModel) {
    return c.json({ success: false, error: "model is required" }, 400);
  }

  const model = resolveModelAlias(normalizeModelId(rawModel));
  const startedAt = Date.now();
  let accountId: number | null = null;

  try {
    const { account, provider, durationMs } = await routeRequest(
      {
        model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1,
        stream: false,
      },
      false
    );

    accountId = account.id;

    return c.json({
      success: true,
      model,
      provider,
      account_id: account.id,
      account_email: account.email,
      latency_ms: durationMs,
    });
  } catch (error) {
    const message = truncateError(
      error instanceof Error ? error.message : String(error)
    );
    return c.json({
      success: false,
      model,
      error: message || "Connection test failed",
      latency_ms: Date.now() - startedAt,
    });
  } finally {
    if (accountId != null) pool.trackRequestEnd(accountId);
  }
});

function truncateError(message: string): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}
