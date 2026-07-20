/**
 * GitHub inventory — reusable credentials (not a proxy/model provider).
 * Routes: /api/accounts/github/*
 */

import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index";
import { accounts } from "../../db/schema";
import { decrypt, encrypt } from "../../utils/crypto";
import { broadcast } from "../../ws/index";

export type GithubImportItem = {
  email?: string;
  password?: string;
  username?: string;
  github_username?: string;
  proxy_country?: string;
  proxy_sessid?: string;
  proxy_url?: string;
  proxy_ip?: string;
  source?: string;
  batch_id?: string;
  status?: string;
};

function parseTokens(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

export function registerGithubAccountRoutes(router: Hono): void {
  /**
   * POST /api/accounts/github/import
   * Upsert inventory rows by (provider=github, email).
   */
  router.post("/github/import", async (c) => {
    const body = await c.req
      .json<{ accounts?: GithubImportItem[] }>()
      .catch(() => ({} as { accounts?: GithubImportItem[] }));
    const items = Array.isArray(body.accounts) ? body.accounts : [];
    if (items.length === 0) {
      return c.json({ error: "accounts array required" }, 400);
    }

    let imported = 0;
    let failed = 0;
    const results: Array<Record<string, unknown>> = [];

    for (const item of items) {
      try {
        const email = String(item.email || "").trim().toLowerCase();
        const password = String(item.password || "").trim();
        const username = String(item.username || item.github_username || "").trim();
        if (!email || !password) {
          failed++;
          results.push({ success: false, error: "email and password required" });
          continue;
        }

        const tokens: Record<string, unknown> = {
          username: username || undefined,
          proxy_country: item.proxy_country || undefined,
          proxy_sessid: item.proxy_sessid || undefined,
          // Keep proxy_url for reuse; list responses can redact later.
          proxy_url: item.proxy_url || undefined,
          proxy_ip: item.proxy_ip || undefined,
          source: item.source || "codebuddy-farm",
          batch_id: item.batch_id || undefined,
        };
        // drop undefined
        for (const k of Object.keys(tokens)) {
          if (tokens[k] === undefined || tokens[k] === "") delete tokens[k];
        }

        const status = String(item.status || "active").trim() || "active";
        const passwordEnc = encrypt(password);

        const existing = await db
          .select()
          .from(accounts)
          .where(and(eq(accounts.provider, "github"), eq(accounts.email, email)))
          .then((rows) => rows[0]);

        if (existing) {
          await db
            .update(accounts)
            .set({
              password: passwordEnc,
              tokens: tokens as unknown,
              status,
              enabled: true,
              errorMessage: null,
              updatedAt: new Date(),
            })
            .where(eq(accounts.id, existing.id));
          imported++;
          results.push({
            email,
            success: true,
            id: existing.id,
            updated: true,
            username: username || null,
          });
        } else {
          const inserted = await db
            .insert(accounts)
            .values({
              provider: "github",
              email,
              password: passwordEnc,
              tokens: tokens as unknown,
              status,
              enabled: true,
              quotaLimit: -1,
              quotaRemaining: -1,
              lastLoginAt: new Date(),
            })
            .returning();
          const created = inserted[0]!;
          imported++;
          results.push({
            email,
            success: true,
            id: created.id,
            updated: false,
            username: username || null,
          });
        }
      } catch (error) {
        failed++;
        results.push({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (imported > 0) {
      broadcast({
        type: "accounts_bulk_created",
        data: { count: imported, provider: "github" },
      });
    }

    return c.json({
      imported,
      failed,
      results,
      success: imported > 0,
      count: imported,
    });
  });

  /**
   * GET /api/accounts/github/export?format=txt|json&include_password=0|1
   */
  router.get("/github/export", async (c) => {
    const format = (c.req.query("format") || "txt").toLowerCase();
    const includePassword = c.req.query("include_password") === "1";

    const rows = await db
      .select()
      .from(accounts)
      .where(eq(accounts.provider, "github"));

    const items = rows.map((row) => {
      const tokens = parseTokens(row.tokens);
      let password = "";
      if (includePassword) {
        try {
          password = decrypt(row.password);
        } catch {
          password = "";
        }
      }
      return {
        id: row.id,
        email: row.email,
        username: String(tokens.username || ""),
        password: includePassword ? password : undefined,
        status: row.status,
        proxy_country: tokens.proxy_country ?? null,
        proxy_sessid: tokens.proxy_sessid ?? null,
        proxy_ip: tokens.proxy_ip ?? null,
        source: tokens.source ?? null,
        batch_id: tokens.batch_id ?? null,
        createdAt: row.createdAt,
      };
    });

    if (format === "json") {
      return c.json({ count: items.length, accounts: items });
    }

    // txt: email|username|password?|country|sessid|status
    const lines = items.map((it) => {
      const parts = [
        it.email,
        it.username,
        includePassword ? it.password || "" : "",
        String(it.proxy_country || ""),
        String(it.proxy_sessid || ""),
        it.status,
      ];
      return parts.join("|");
    });
    const header = includePassword
      ? "email|username|password|country|sessid|status"
      : "email|username||country|sessid|status";
    const body = [header, ...lines].join("\n") + "\n";
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="github-inventory.${includePassword ? "secrets." : ""}txt"`,
      },
    });
  });
}
