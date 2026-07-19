/**
 * CodeBuddy create-account helpers used by POST /api/accounts.
 * Keeps bulk ck_ key + session/JWT import out of the main router body.
 */

import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index";
import { accounts } from "../../db/schema";
import { encrypt } from "../../utils/crypto";
import { broadcast } from "../../ws/index";
import { pool } from "../../proxy/pool";

type CreateBody = {
  provider: string;
  email?: string;
  apiKeys?: string;
  session?: unknown;
  accessToken?: string;
  access_token?: string;
  refreshToken?: string;
  refresh_token?: string;
  tokens?: Record<string, unknown> | string;
};

/**
 * Handle CodeBuddy bulk API keys and session import branches.
 * Returns a Hono Response when handled, or null to fall through.
 */
export async function tryCreateCodeBuddyAccount(
  c: Context,
  body: CreateBody
): Promise<Response | null> {
  // Bulk API key flow (global + China)
  if ((body.provider === "codebuddy" || body.provider === "codebuddy-china") && body.apiKeys) {
    const provider = body.provider;
    const keys = body.apiKeys
      .split("\n")
      .map((k: string) => k.trim())
      .filter((k: string) => k.length > 0);

    if (keys.length === 0) {
      return c.json({ error: "apiKeys is empty" }, 400);
    }

    for (let i = 0; i < keys.length; i++) {
      if (!keys[i]!.startsWith("ck_")) {
        return c.json(
          { error: `Invalid API key format on line ${i + 1} (must start with ck_)` },
          400
        );
      }
    }

    const created: Array<{ id: number; email: string }> = [];
    const existingCount = await db
      .select()
      .from(accounts)
      .where(eq(accounts.provider, provider))
      .then((rows) => rows.length);
    const emailPrefix = provider === "codebuddy-china" ? "cbc-account" : "cb-account";

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const email = `${emailPrefix}-${existingCount + i + 1}`;
      const encryptedKey = encrypt(key);
      const tokens = { api_key: key };

      const inserted = await db
        .insert(accounts)
        .values({
          provider,
          email,
          password: encryptedKey,
          status: "active",
          tokens,
          quotaLimit: -1,
          quotaRemaining: -1,
          lastLoginAt: new Date(),
        })
        .returning();

      if (inserted[0]) {
        created.push({ id: inserted[0].id, email });
      }
    }

    pool.invalidate(provider as any);
    broadcast({ type: "account_created", data: { provider, count: created.length } });

    return c.json(
      {
        success: true,
        count: created.length,
        accounts: created,
      },
      201
    );
  }

  // Session / JWT import (global only)
  if (
    body.provider === "codebuddy" &&
    (body.session || body.accessToken || body.access_token || body.tokens)
  ) {
    const { normalizeCodeBuddySessionImport } = await import(
      "../proxy/providers/codebuddy-auth"
    );
    const raw =
      body.session ??
      body.tokens ??
      (body.accessToken || body.access_token
        ? {
            access_token: body.accessToken || body.access_token,
            refresh_token: body.refreshToken || body.refresh_token,
            email: body.email,
          }
        : null);
    const normalized = normalizeCodeBuddySessionImport(raw);
    if ("error" in normalized) {
      return c.json({ error: normalized.error }, 400);
    }

    const bearer =
      normalized.tokens.api_key ||
      normalized.tokens.access_token ||
      normalized.tokens.session_token ||
      "";
    if (!bearer) return c.json({ error: "no usable token in session payload" }, 400);

    const email =
      (typeof body.email === "string" && body.email.trim()) ||
      normalized.email ||
      `cb-session-${Date.now().toString(36)}`;

    const existing = await db
      .select()
      .from(accounts)
      .where(eq(accounts.email, email))
      .then((rows) => rows.find((r) => r.provider === "codebuddy"));

    const encryptedPlaceholder = encrypt(bearer.startsWith("ck_") ? bearer : "session-jwt");

    if (existing) {
      await db
        .update(accounts)
        .set({
          password: encryptedPlaceholder,
          status: "active",
          tokens: normalized.tokens as unknown,
          errorMessage: null,
          lastLoginAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, existing.id));
      pool.invalidate("codebuddy");
      broadcast({
        type: "account_updated",
        data: { id: existing.id, provider: "codebuddy", status: "active" },
      });
      return c.json(
        { id: existing.id, provider: "codebuddy", email, status: "active", updated: true },
        200
      );
    }

    const inserted = await db
      .insert(accounts)
      .values({
        provider: "codebuddy",
        email,
        password: encryptedPlaceholder,
        status: "active",
        tokens: normalized.tokens as unknown,
        quotaLimit: -1,
        quotaRemaining: -1,
        lastLoginAt: new Date(),
      })
      .returning();
    const created = inserted[0]!;
    pool.invalidate("codebuddy");
    broadcast({
      type: "account_created",
      data: { id: created.id, provider: "codebuddy", email },
    });
    return c.json({ ...created, password: "***", tokens: "[set]" }, 201);
  }

  return null;
}
