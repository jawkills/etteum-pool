/**
 * Grok account routes: CPA import, farm job, reauth job.
 * Mounted on accountsRouter so URLs stay /api/accounts/grok/*.
 */

import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index";
import { accounts } from "../../db/schema";
import { encrypt } from "../../utils/crypto";
import { broadcast } from "../../ws/index";
import { pool, type ProviderName } from "../../proxy/pool";
import { normalizeGrokCpa } from "../../proxy/providers/grok";
import { grokFarmQueue } from "../../auth/grok-farm/farm-queue";
import { grokReauthQueue } from "../../auth/grok-farm/reauth-queue";
import { isPlaceholderPassword } from "../../proxy/account-health";

export function registerGrokAccountRoutes(router: Hono): void {
  /**
   * POST /api/accounts/grok/import - Bulk import CPA JSON tokens for grok.
   * Body: { accounts?: any[]; text?: string }
   */
  router.post("/grok/import", async (c) => {
    const body = await c.req.json<{ accounts?: any[]; text?: string }>();

    let items: any[] = [];
    if (Array.isArray(body.accounts) && body.accounts.length > 0) {
      items = body.accounts;
    } else if (typeof body.text === "string" && body.text.trim()) {
      const text = body.text.trim();
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) items = parsed;
        else if (parsed && typeof parsed === "object") items = [parsed];
        else return c.json({ error: "text must be a JSON object or array" }, 400);
      } catch {
        items = [];
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            items.push(JSON.parse(trimmed));
          } catch (err) {
            return c.json(
              {
                error: `Invalid NDJSON line: ${err instanceof Error ? err.message : String(err)}`,
              },
              400
            );
          }
        }
        if (items.length === 0) {
          return c.json(
            { error: "Could not parse text as JSON array, object, or NDJSON" },
            400
          );
        }
      }
    } else {
      return c.json({ error: "accounts array or text is required" }, 400);
    }

    const existingRows = await db
      .select()
      .from(accounts)
      .where(eq(accounts.provider, "grok"));

    const results: Array<{
      email?: string;
      success: boolean;
      id?: number;
      updated?: boolean;
      error?: string;
    }> = [];
    let imported = 0;
    let failed = 0;

    for (const item of items) {
      try {
        const norm = normalizeGrokCpa(item);
        const tokensJson: Record<string, unknown> = {
          access_token: norm.access_token,
          refresh_token: norm.refresh_token,
          token_type: norm.token_type || "Bearer",
          client_id: norm.client_id,
          email: norm.email,
        };
        if (norm.id_token) tokensJson.id_token = norm.id_token;
        if (norm.team_id) tokensJson.team_id = norm.team_id;
        if (norm.sub) tokensJson.sub = norm.sub;
        if (norm.expires_at != null) tokensJson.expires_at = norm.expires_at;

        const emailLower = norm.email.toLowerCase();
        const existing = existingRows.find((r) => r.email.toLowerCase() === emailLower);

        const rawPassword =
          item && typeof item === "object"
            ? String((item as any).password || (item as any).xai_password || "").trim()
            : "";
        const hasRealPassword = !isPlaceholderPassword(rawPassword);
        const passwordEnc = hasRealPassword
          ? encrypt(rawPassword)
          : encrypt("grok-token-auth");

        if (existing) {
          const updatePayload: Record<string, unknown> = {
            tokens: tokensJson as unknown,
            status: "active",
            enabled: true,
            quotaLimit: 0, // unknown until center headers
            quotaRemaining: existing.quotaRemaining ?? 0,
            errorMessage: null,
            updatedAt: new Date(),
          };
          if (hasRealPassword) {
            updatePayload.password = passwordEnc;
          }
          await db
            .update(accounts)
            .set(updatePayload)
            .where(eq(accounts.id, existing.id));
          existing.tokens = tokensJson as unknown;
          existing.status = "active";
          existing.enabled = true;
          if (updatePayload.password) existing.password = passwordEnc as string;
          imported++;
          results.push({ email: norm.email, success: true, id: existing.id, updated: true });
        } else {
          const inserted = await db
            .insert(accounts)
            .values({
              provider: "grok",
              email: norm.email,
              password: passwordEnc,
              tokens: tokensJson as unknown,
              status: "active",
              enabled: true,
              quotaLimit: 0, // unknown until center headers
              quotaRemaining: 0,
            })
            .returning();
          const created = inserted[0]!;
          existingRows.push(created);
          imported++;
          results.push({ email: norm.email, success: true, id: created.id, updated: false });
        }
      } catch (error) {
        failed++;
        const emailHint =
          item && typeof item === "object"
            ? String((item as any).email || (item as any).user_email || "")
            : "";
        results.push({
          email: emailHint || undefined,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    pool.invalidate("grok" as ProviderName);
    broadcast({
      type: "accounts_bulk_created",
      data: { count: imported, provider: "grok" },
    });

    return c.json({ imported, failed, results });
  });

  /** POST /api/accounts/grok/farm */
  router.post("/grok/farm", async (c) => {
    const body = await c.req
      .json<{ count?: number; concurrent?: number }>()
      .catch(() => ({} as any));
    const count = Number(body.count);
    if (!Number.isFinite(count) || count < 1) {
      return c.json({ error: "count >= 1 required" }, 400);
    }
    const concurrent = Number(body.concurrent) > 0 ? Number(body.concurrent) : 1;
    const result = await grokFarmQueue.start({ count, concurrent });
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json({ data: result.status });
  });

  router.get("/grok/farm", (c) => {
    return c.json({ data: grokFarmQueue.getStatus() });
  });

  router.post("/grok/farm/stop", (c) => {
    const result = grokFarmQueue.stop();
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json({ data: grokFarmQueue.getStatus() });
  });

  /** POST /api/accounts/grok/reauth */
  router.post("/grok/reauth", async (c) => {
    const body = await c.req
      .json<{
        ids?: number[];
        onlyDead?: boolean;
        concurrent?: number;
        defaultPassword?: string;
      }>()
      .catch(() => ({} as any));

    const result = await grokReauthQueue.start({
      ids: body.ids,
      onlyDead: body.onlyDead,
      concurrent: body.concurrent,
      defaultPassword: body.defaultPassword,
    });
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json({ data: result.status, skipped: result.skipped });
  });

  router.get("/grok/reauth", (c) => {
    return c.json({ data: grokReauthQueue.getStatus() });
  });

  router.post("/grok/reauth/stop", (c) => {
    const result = grokReauthQueue.stop();
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json({ data: grokReauthQueue.getStatus() });
  });

  /**
   * POST /api/accounts/grok/import-backup
   * Restore accounts from export-grok-cpa JSONL / JSON array.
   * Body: { text?: string; accounts?: any[] }
   */
  router.post("/grok/import-backup", async (c) => {
    const body = await c.req.json<{ accounts?: any[]; text?: string }>();

    let items: any[] = [];
    if (Array.isArray(body.accounts) && body.accounts.length > 0) {
      items = body.accounts;
    } else if (typeof body.text === "string" && body.text.trim()) {
      const text = body.text.trim();
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) items = parsed;
        else if (parsed && typeof parsed === "object") items = [parsed];
        else return c.json({ error: "text must be a JSON object or array" }, 400);
      } catch {
        items = [];
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            items.push(JSON.parse(trimmed));
          } catch (err) {
            return c.json(
              {
                error: `Invalid NDJSON line: ${err instanceof Error ? err.message : String(err)}`,
              },
              400
            );
          }
        }
        if (items.length === 0) {
          return c.json(
            { error: "Could not parse text as JSON array, object, or NDJSON" },
            400
          );
        }
      }
    } else {
      return c.json({ error: "accounts array or text is required" }, 400);
    }

    // Flatten export records: { tokens, email, ... } → CPA shape
    items = items.map((item) => {
      if (item && typeof item === "object" && item.tokens && typeof item.tokens === "object") {
        return {
          ...item.tokens,
          email: item.email || item.tokens.email,
          password: item.password,
          metadata: item.metadata,
        };
      }
      return item;
    });

    const existingRows = await db
      .select()
      .from(accounts)
      .where(eq(accounts.provider, "grok"));

    const results: Array<{
      email?: string;
      success: boolean;
      id?: number;
      updated?: boolean;
      error?: string;
    }> = [];
    let imported = 0;
    let failed = 0;

    for (const item of items) {
      try {
        const norm = normalizeGrokCpa(item);
        const tokensJson: Record<string, unknown> = {
          access_token: norm.access_token,
          refresh_token: norm.refresh_token,
          token_type: norm.token_type || "Bearer",
          client_id: norm.client_id,
          email: norm.email,
        };
        if (norm.id_token) tokensJson.id_token = norm.id_token;
        if (norm.team_id) tokensJson.team_id = norm.team_id;
        if (norm.sub) tokensJson.sub = norm.sub;
        if (norm.expires_at != null) tokensJson.expires_at = norm.expires_at;

        const emailLower = norm.email.toLowerCase();
        const existing = existingRows.find((r) => r.email.toLowerCase() === emailLower);
        const passwordEnc = encrypt("grok-token-auth");

        if (existing) {
          await db
            .update(accounts)
            .set({
              tokens: tokensJson as unknown,
              status: "active",
              enabled: true,
              quotaLimit: 0, // unknown until center headers
              quotaRemaining: existing.quotaRemaining ?? 0,
              errorMessage: null,
              updatedAt: new Date(),
            })
            .where(eq(accounts.id, existing.id));
          imported++;
          results.push({ email: norm.email, success: true, id: existing.id, updated: true });
        } else {
          const inserted = await db
            .insert(accounts)
            .values({
              provider: "grok",
              email: norm.email,
              password: passwordEnc,
              tokens: tokensJson as unknown,
              status: "active",
              enabled: true,
              quotaLimit: 0, // unknown until center headers
              quotaRemaining: 0,
            })
            .returning();
          const created = inserted[0]!;
          existingRows.push(created);
          imported++;
          results.push({ email: norm.email, success: true, id: created.id, updated: false });
        }
      } catch (error) {
        failed++;
        const emailHint =
          item && typeof item === "object"
            ? String((item as any).email || (item as any).user_email || "")
            : "";
        results.push({
          email: emailHint || undefined,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    pool.invalidate("grok" as ProviderName);
    broadcast({
      type: "accounts_bulk_created",
      data: { count: imported, provider: "grok", source: "import-backup" },
    });

    return c.json({ imported, failed, results, source: "import-backup" });
  });

}
