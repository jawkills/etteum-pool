/**
 * CodeBuddy farm routes + richer import for farmed ck_ keys.
 * Mounted on accountsRouter → /api/accounts/codebuddy/*
 */

import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index";
import { accounts } from "../../db/schema";
import { encrypt } from "../../utils/crypto";
import { broadcast } from "../../ws/index";
import { pool, type ProviderName } from "../../proxy/pool";
import { codebuddyFarmQueue } from "../../auth/codebuddy-farm/farm-queue";
import {
  getCodeBuddyFarmUiDefaults,
  loadCodeBuddyFarmSettings,
  redactCodeBuddyFarmSettings,
} from "../../auth/codebuddy-farm/settings";

type ImportItem = {
  email?: string;
  api_key?: string;
  apiKey?: string;
  key?: string;
  github_username?: string;
  github_account_id?: number | string;
  password?: string;
  mode?: string;
  proxy_country?: string;
};

export function registerCodeBuddyFarmRoutes(router: Hono): void {
  /**
   * POST /api/accounts/codebuddy/import
   * Body: { accounts: [{ email, api_key, github_username?, password?, mode? }] }
   */
  router.post("/codebuddy/import", async (c) => {
    const body = await c.req.json<{ accounts?: ImportItem[] }>().catch(() => ({} as any));
    const items = Array.isArray(body.accounts) ? body.accounts : [];
    if (items.length === 0) {
      return c.json({ error: "accounts array required" }, 400);
    }

    let imported = 0;
    let failed = 0;
    const results: Array<Record<string, unknown>> = [];

    const existingRows = await db
      .select()
      .from(accounts)
      .where(eq(accounts.provider, "codebuddy"));

    for (const item of items) {
      try {
        const apiKey = String(item.api_key || item.apiKey || item.key || "").trim();
        if (!apiKey.startsWith("ck_")) {
          failed++;
          results.push({ success: false, error: "api_key must start with ck_" });
          continue;
        }
        const ghUser = String(item.github_username || "").trim();
        let email = String(item.email || "").trim();
        if (!email) {
          email = ghUser ? `cb-${ghUser}` : `cb-account-${existingRows.length + imported + 1}`;
        }
        const emailLower = email.toLowerCase();
        const existing = existingRows.find((r) => r.email.toLowerCase() === emailLower);

        const ghAccountId = Number(item.github_account_id);
        const tokens: Record<string, unknown> = {
          api_key: apiKey,
          ...(ghUser ? { github_username: ghUser } : {}),
          ...(Number.isFinite(ghAccountId) && ghAccountId > 0
            ? { github_account_id: ghAccountId }
            : {}),
          ...(item.mode ? { farm_mode: item.mode } : {}),
          ...(item.proxy_country ? { proxy_country: item.proxy_country } : {}),
        };
        const passwordEnc = encrypt(
          item.password ? String(item.password) : apiKey,
        );

        if (existing) {
          await db
            .update(accounts)
            .set({
              password: passwordEnc,
              tokens: tokens as unknown,
              status: "active",
              enabled: true,
              errorMessage: null,
              lastLoginAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(accounts.id, existing.id));
          imported++;
          results.push({ email, success: true, id: existing.id, updated: true });
        } else {
          const inserted = await db
            .insert(accounts)
            .values({
              provider: "codebuddy",
              email,
              password: passwordEnc,
              tokens: tokens as unknown,
              status: "active",
              enabled: true,
              quotaLimit: -1,
              quotaRemaining: -1,
              lastLoginAt: new Date(),
            })
            .returning();
          const created = inserted[0]!;
          existingRows.push(created);
          imported++;
          results.push({ email, success: true, id: created.id, updated: false });
        }
      } catch (error) {
        failed++;
        results.push({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    pool.invalidate("codebuddy" as ProviderName);
    broadcast({
      type: "accounts_bulk_created",
      data: { count: imported, provider: "codebuddy" },
    });

    return c.json({ imported, failed, results, success: imported > 0, count: imported });
  });

  /** GET /api/accounts/codebuddy/farm/settings — redacted farm config + UI defaults */
  router.get("/codebuddy/farm/settings", async (c) => {
    const map = await loadCodeBuddyFarmSettings();
    const defaults = getCodeBuddyFarmUiDefaults(map);
    return c.json({
      data: {
        settings: redactCodeBuddyFarmSettings(map),
        defaults,
        configured: {
          hme: Boolean(map["codebuddy_farm.hme_url"]),
          di: Boolean(map["codebuddy_farm.di_login"] && map["codebuddy_farm.di_password"]),
          solver: Boolean(map["codebuddy_farm.captcha_solver_url"]),
        },
      },
    });
  });

  /** POST /api/accounts/codebuddy/farm */
  router.post("/codebuddy/farm", async (c) => {
    const body = await c.req
      .json<{ count?: number; concurrent?: number }>()
      .catch(() => ({} as any));
    const count = Number(body.count);
    if (!Number.isFinite(count) || count < 1) {
      return c.json({ error: "count >= 1 required" }, 400);
    }
    const concurrent = Number(body.concurrent) > 0 ? Number(body.concurrent) : 1;
    const result = await codebuddyFarmQueue.start({ count, concurrent });
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json({ data: result.status });
  });

  router.get("/codebuddy/farm", (c) => {
    return c.json({ data: codebuddyFarmQueue.getStatus() });
  });

  router.post("/codebuddy/farm/stop", (c) => {
    const result = codebuddyFarmQueue.stop();
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json({ data: codebuddyFarmQueue.getStatus() });
  });
}
