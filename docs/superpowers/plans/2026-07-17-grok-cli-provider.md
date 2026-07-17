# GrokCLI Native Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native `grok-cli` provider to etteum-pool that imports CPA account tokens (JSON), safely refreshes OAuth tokens at thousands-of-accounts scale, and proxies OpenAI-compatible chat to xAI Grok CLI upstream.

**Architecture:** Port request/header/refresh contract from `C:\Users\Administrator\Documents\bot\grok-cli-proxy` (github.com/dudevkit/grok-cli-proxy) into a `BaseProvider` subclass. Borrow **refreshLocks + on-401-once + proactive expiry** patterns from CLIProxyAPI (github.com/router-for-me/CLIProxyAPI). Accounts live in etteum SQLite (`provider = "grok-cli"`). Import is token-JSON only (no browser login). Pool/LB/warmup/dashboard reuse existing infrastructure.

**Scale target:** Thousands of CPA accounts must stay **safe** (no mass RT death). Speed comes from concurrent + lazy refresh — never serial full-pool refresh on the request path.

**Tech Stack:** Bun + TypeScript, Hono API, Drizzle/SQLite, existing `BaseProvider` + `registry.ts` + dashboard Accounts page.

**Source of truth for upstream contract:**
- Upstream chat: `https://cli-chat-proxy.grok.com/v1`
- Token refresh: `https://auth.x.ai/oauth2/token`
- OAuth client_id: `b1a00492-073a-47ea-816f-4c329264a828`
- Default model: `grok-4.5`
- Token budget per account: `2_000_000` (local tracking via `quotaLimit` / `quotaRemaining`)
- CLI headers: `X-XAI-Token-Auth` / `x-xai-token-auth: xai-grok-cli`, `x-grok-model-override`, client version/identifier

**Explicit non-goals (MVP):**
- Do not create: Python sidecar, second SQLite DB, full dashboard clone of grok-cli-proxy, dual stack with CLIProxyAPI/grok2api as primary
- Do not implement: browser OAuth login, `/v1/responses` native, multi-model catalog beyond `grok-4.5`, "modif created_at" hacks

---

## Safety model (non-negotiable — implement before claiming done)

Ribuan akun **aman** = jangan bunuh refresh_token, jangan race, jangan mark mati salah.

| # | Rule | Why |
|---|------|-----|
| S1 | **Lazy + almost-expired only** — never full-pool serial refresh on request path | Scale |
| S2 | **1 refresh in-flight per accountId** (`refreshLocks` Map of Promise) | Prevents RT rotation races |
| S3 | **Cross-account concurrency 50–100** for background/import only | Throughput without serial hours |
| S4 | **Persist new tokens before next use** — set `result.tokens` so router calls `pool.updateTokens` | Or access dies next request |
| S5 | **`refresh_token: data.refresh_token \|\| old.refresh_token`** — never clobber with null/undefined | Classic mass-dead bug |
| S6 | **Classify strictly:** 401 generic = auth (refresh); `invalid_grant`/`revoked`/`unknown refresh` = permanent error; 403 spending/quota = `quotaExhausted` | Avoid over-marking dead |
| S7 | **Max 1 refresh + 1 retry** per request per account | No refresh storms |
| S8 | **Single refresh owner:** prefer Kiro-style (provider refreshes + `result.tokens`). Do **not** also rely on router double-refresh for the same 401 without locks. Error string after permanent fail must not re-trigger endless router refresh. | Double-refresh kills RT |
| S9 | Schema fields are **`quotaLimit` / `quotaRemaining`** — not creditLimit/creditRemaining | Matches `schema.ts` |
| S10 | ProviderResult exhausted flag is **`quotaExhausted: true`** — not `exhausted` / invent `statusCode` | Matches `base.ts` + `router.ts` |

### 401 / 403 decision table

| Signal | Kind | Action |
|--------|------|--------|
| 403 or body has spending limit / credits exhausted / quota | exhausted | `quotaExhausted: true` → `pool.markExhausted`. **Keep RT.** |
| 401 + `invalid_grant` / `revoked` / `unknown refresh` | dead | `markError` with clear message. **Stop refresh.** |
| 401 + expired / unauthorized / invalid token / generic | auth | refresh once (lock) → persist → retry once |
| 429 / 5xx / network | transient | `markTransientFailure`, try next account |
| Refresh network fail | transient | do **not** mark dead; retry later via warmup/background |

Etteum status values: `active | exhausted | error | pending`. Permanent RT death = `status: "error"` + `errorMessage` containing `invalid_grant`/`revoked`.

### Scale paths

```
REQUEST (hot):
  pick account → if expires_at < now+45m → refresh(lock) → chat
  → 401 auth → refresh once + persist + retry once
  → 401 dead → mark error, next account
  → 403 exhausted → mark exhausted, next account

BACKGROUND (cold, optional Phase 2):
  every 5–15 min → SELECT active where expires soon only
  → refresh concurrent 50–100 → invalid_grant → mark error, stop spam

IMPORT:
  concurrent 20–30 → normalize → save → optional 1x refresh
  → dead RT → status error (not in pool)
```

---

## File map

| Path | Action | Responsibility |
|------|--------|----------------|
| `src/proxy/providers/grok-cli.ts` | Create | Helpers + `GrokCliProvider` + refreshLocks + classify |
| `src/proxy/providers/grok-cli.test.ts` | Create | Unit tests: normalize, ownsModel, headers, classify, lock behavior if pure-testable |
| `src/proxy/providers/registry.ts` | Modify | Register after youmind, before byok |
| `src/api/accounts.ts` | Modify | `POST /api/accounts/grok-cli/import` + provider union |
| `dashboard/src/pages/Accounts.tsx` | Modify | Provider tab + JSON import UI |
| `dashboard/src/lib/api.ts` | Modify | Types + `importGrokCliAccounts` |
| `dashboard/src/pages/AccountList.tsx` | Modify | Label `grok-cli` → `Grok CLI` if needed |
| `dashboard/src/pages/Settings.tsx` | Modify | `labelFor` if hardcoded list |
| `src/auth/warmup-runner.ts` | Inspect | Default healthCheck should work; only patch if switch/allowlist |
| `src/config.ts` | Optional | Env overrides (helpers may use `process.env` directly) |

**Do not create:** separate Python service, second DB, full grok-cli-proxy UI clone.

---

## Phase overview

| Phase | Tasks | Goal |
|-------|-------|------|
| **1 Safety** | 1–4 | Helpers, provider with safe refresh, registry, import API |
| **2 Scale** | 5–6 | Dashboard + credit path verify; proactive/background optional |
| **3 Ops** | 7–8 | Warmup verify, E2E checklist, optional README |

Execution order for subagents: Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8.

---

### Task 1: CPA normalize + pure helpers (TDD)

**Files:**
- Create: `src/proxy/providers/grok-cli.test.ts`
- Create: `src/proxy/providers/grok-cli.ts` (helpers only first)

- [ ] **Step 1: Write failing tests for normalize + ownsModel + headers + classify**

```ts
// src/proxy/providers/grok-cli.test.ts
import { describe, expect, test } from "bun:test";
import {
  normalizeGrokCliCpa,
  grokCliOwnsModel,
  buildGrokCliHeaders,
  classifyGrokCliError,
  GROK_CLI_TOKEN_LIMIT,
} from "./grok-cli";

describe("normalizeGrokCliCpa", () => {
  test("accepts flat CPA", () => {
    const out = normalizeGrokCliCpa({
      email: "a@x.com",
      access_token: "at",
      refresh_token: "rt",
      id_token: "idt",
    });
    expect(out.email).toBe("a@x.com");
    expect(out.access_token).toBe("at");
    expect(out.refresh_token).toBe("rt");
  });

  test("accepts nested tokens harvest format", () => {
    const out = normalizeGrokCliCpa({
      email: "b@x.com",
      tokens: { access_token: "at2", refresh_token: "rt2", id_token: "id2" },
    });
    expect(out.access_token).toBe("at2");
    expect(out.refresh_token).toBe("rt2");
  });

  test("accepts camelCase keys", () => {
    const out = normalizeGrokCliCpa({
      email: "c@x.com",
      accessToken: "at3",
      refreshToken: "rt3",
    });
    expect(out.access_token).toBe("at3");
    expect(out.refresh_token).toBe("rt3");
  });

  test("throws when tokens missing", () => {
    expect(() => normalizeGrokCliCpa({ email: "x@x.com" })).toThrow(/access_token/);
  });

  test("extracts team_id/sub from id_token JWT payload when present", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "user-1", team_id: "team-9" })).toString("base64url");
    const idToken = `aaa.${payload}.bbb`;
    const out = normalizeGrokCliCpa({
      email: "d@x.com",
      access_token: "at",
      refresh_token: "rt",
      id_token: idToken,
    });
    expect(out.sub).toBe("user-1");
    expect(out.team_id).toBe("team-9");
  });
});

describe("grokCliOwnsModel", () => {
  test("owns grok-4.5", () => {
    expect(grokCliOwnsModel("grok-4.5")).toBe(true);
  });
  test("owns prefixed grok-cli-grok-4.5", () => {
    expect(grokCliOwnsModel("grok-cli-grok-4.5")).toBe(true);
  });
  test("does not own claude/gpt ids", () => {
    expect(grokCliOwnsModel("claude-sonnet-4.6")).toBe(false);
    expect(grokCliOwnsModel("gpt-4o")).toBe(false);
  });
});

describe("buildGrokCliHeaders", () => {
  test("includes required CLI auth headers and model override", () => {
    const h = buildGrokCliHeaders(
      {
        access_token: "tok",
        email: "a@x.com",
        team_id: "t1",
        sub: "u1",
      },
      "grok-4.5"
    );
    expect(h.Authorization).toBe("Bearer tok");
    expect(h["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
    expect(h["x-xai-token-auth"]).toBe("xai-grok-cli");
    expect(h["x-grok-model-override"]).toBe("grok-4.5");
    expect(h["x-email"]).toBe("a@x.com");
    expect(h["x-teamid"]).toBe("t1");
    expect(h["x-userid"]).toBe("u1");
  });
});

describe("classifyGrokCliError", () => {
  test("403 spending limit => exhausted", () => {
    expect(classifyGrokCliError(403, "credits are exhausted")).toBe("exhausted");
  });
  test("401 revoked => dead", () => {
    expect(classifyGrokCliError(401, "invalid_grant revoked")).toBe("dead");
  });
  test("401 generic => auth", () => {
    expect(classifyGrokCliError(401, "unauthorized")).toBe("auth");
  });
  test("other => null", () => {
    expect(classifyGrokCliError(500, "boom")).toBe(null);
  });
});

describe("constants", () => {
  test("token limit is 2M", () => {
    expect(GROK_CLI_TOKEN_LIMIT).toBe(2_000_000);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL (module missing)**

```powershell
cd C:\Users\Administrator\etteum-pool
bun test src/proxy/providers/grok-cli.test.ts
```

Expected: fail resolving `./grok-cli` or exports.

- [ ] **Step 3: Implement helpers in `grok-cli.ts`**

```ts
// src/proxy/providers/grok-cli.ts  (helpers section — class in Task 2)

export const GROK_CLI_TOKEN_LIMIT = 2_000_000;
export const GROK_CLI_UPSTREAM_BASE =
  process.env.GROK_CLI_UPSTREAM_BASE?.replace(/\/$/, "") ||
  "https://cli-chat-proxy.grok.com/v1";
export const GROK_CLI_TOKEN_URL =
  process.env.GROK_CLI_TOKEN_URL || "https://auth.x.ai/oauth2/token";
export const GROK_CLI_CLIENT_ID =
  process.env.GROK_CLI_CLIENT_ID || "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_CLI_CLIENT_VERSION =
  process.env.GROK_CLI_CLIENT_VERSION || "0.2.99";
export const GROK_CLI_CLIENT_IDENTIFIER =
  process.env.GROK_CLI_CLIENT_IDENTIFIER || "grok-pager";
/** Proactive refresh when access token remaining lifetime below this (seconds). */
export const GROK_CLI_REFRESH_LEAD_SEC = Number(process.env.GROK_CLI_REFRESH_LEAD_SEC) || 45 * 60;

export type GrokCliTokens = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  team_id?: string;
  sub?: string;
  user_id?: string;
  principal_id?: string;
  token_type?: string;
  email?: string;
  /** unix seconds string or number when access expires */
  expires_at?: string | number;
  client_id?: string;
};

export type GrokCliNormalized = GrokCliTokens & { email: string };

function b64urlJson(part: string): any | null {
  try {
    const pad = part.length % 4 === 0 ? "" : "=".repeat(4 - (part.length % 4));
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function normalizeGrokCliCpa(input: any): GrokCliNormalized {
  let p = input && typeof input === "object" ? { ...input } : {};
  if (p.tokens && typeof p.tokens === "object") {
    const nested = p.tokens;
    p = { ...nested, ...p };
    for (const k of [
      "access_token", "refresh_token", "id_token", "token_type",
      "accessToken", "refreshToken", "idToken",
    ]) {
      if (!p[k] && nested[k]) p[k] = nested[k];
    }
    if (!p.email && nested.email) p.email = nested.email;
  }

  const access = p.access_token || p.accessToken;
  const refresh = p.refresh_token || p.refreshToken;
  if (!access || !refresh) {
    throw new Error("access_token and refresh_token required");
  }
  const email = String(p.email || p.user_email || "").trim();
  if (!email) throw new Error("email required");

  const idToken = p.id_token || p.idToken || "";
  let sub = p.sub || p.user_id || p.principal_id || "";
  let teamId = p.team_id || p.teamId || "";
  if (idToken && idToken.split(".").length >= 2) {
    const claims = b64urlJson(idToken.split(".")[1]!);
    if (claims) {
      if (!sub) sub = claims.sub || claims.user_id || claims.principal_id || "";
      if (!teamId) teamId = claims.team_id || claims.teamId || "";
    }
  }

  return {
    email,
    access_token: String(access),
    refresh_token: String(refresh),
    id_token: idToken ? String(idToken) : undefined,
    team_id: teamId ? String(teamId) : undefined,
    sub: sub ? String(sub) : undefined,
    token_type: p.token_type || "Bearer",
    client_id: p.client_id || GROK_CLI_CLIENT_ID,
    expires_at: p.expires_at || p.expiresAt || undefined,
  };
}

export function resolveGrokCliUpstreamModel(model: string): string {
  const m = model.trim();
  if (m.toLowerCase().startsWith("grok-cli-")) return m.slice("grok-cli-".length);
  return m;
}

export function grokCliOwnsModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (m === "grok-4.5") return true;
  if (m.startsWith("grok-cli-")) {
    const up = m.slice("grok-cli-".length);
    return up === "grok-4.5" || up.startsWith("grok-");
  }
  // bare grok-4* for CLI catalog; avoid stealing unrelated models
  return m === "grok-4.5" || m.startsWith("grok-4");
}

export function buildGrokCliHeaders(
  tokens: Pick<GrokCliTokens, "access_token" | "email" | "team_id" | "sub" | "user_id" | "principal_id"> & { email?: string },
  model: string,
  clientVersion = GROK_CLI_CLIENT_VERSION
): Record<string, string> {
  const ver = clientVersion;
  const h: Record<string, string> = {
    Authorization: `Bearer ${tokens.access_token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `grok-pager/${ver} grok-shell/${ver} (linux; x86_64)`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
    "x-grok-client-version": ver,
    "x-authenticateresponse": "authenticate-response",
    "x-grok-model-override": resolveGrokCliUpstreamModel(model),
  };
  if (tokens.email) h["x-email"] = tokens.email;
  const uid = tokens.sub || tokens.user_id || tokens.principal_id;
  if (uid) h["x-userid"] = String(uid);
  if (tokens.team_id) h["x-teamid"] = String(tokens.team_id);
  return h;
}

export type GrokCliErrorKind = "exhausted" | "dead" | "auth" | null;

export function classifyGrokCliError(status: number, body: string): GrokCliErrorKind {
  const low = (body || "").toLowerCase();
  if (
    status === 403 ||
    low.includes("spending limit") ||
    low.includes("credits are exhausted") ||
    low.includes("quota")
  ) {
    // Prefer dead if body clearly says revoked even with 403-ish wording
    if (low.includes("invalid_grant") || low.includes("revoked")) return "dead";
    return "exhausted";
  }
  if (status === 401) {
    if (low.includes("invalid_grant") || low.includes("revoked") || low.includes("unknown refresh")) {
      return "dead";
    }
    return "auth";
  }
  if (low.includes("invalid_grant") || low.includes("revoked")) return "dead";
  return null;
}

/** True if access token should be refreshed before calling upstream. */
export function grokCliNeedsProactiveRefresh(
  tokens: GrokCliTokens,
  leadSec = GROK_CLI_REFRESH_LEAD_SEC,
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  const raw = tokens.expires_at;
  if (raw == null || raw === "") return false; // unknown expiry: rely on 401 path
  const exp = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  // support both unix seconds and ms
  const expSec = exp > 1e12 ? Math.floor(exp / 1000) : exp;
  return expSec - nowSec < leadSec;
}
```

- [ ] **Step 4: Re-run tests — expect PASS**

```powershell
bun test src/proxy/providers/grok-cli.test.ts
```

- [ ] **Step 5: Commit**

```powershell
git add src/proxy/providers/grok-cli.ts src/proxy/providers/grok-cli.test.ts
git commit -m "feat(grok-cli): add CPA normalize helpers and unit tests"
```

---

### Task 2: `GrokCliProvider` class (chat + stream + safe refresh + quota)

**Files:**
- Modify: `src/proxy/providers/grok-cli.ts`
- Pattern reference: `src/proxy/providers/kiro.ts` (refresh + `result.tokens`), `src/proxy/providers/youmind.ts` (ModelInfo shape), `src/proxy/providers/base.ts` (`ProviderResult`)

**Hard requirements for this task:**
1. `ModelInfo` must use real fields: `id`, `object: "model"`, `created`, `owned_by`, optional credit fields — **not** `name`/`provider`.
2. Exhausted → `quotaExhausted: true` (never invent `exhausted` / `statusCode`).
3. After successful refresh used for a call, set **`result.tokens`** so router persists.
4. `refreshToken` uses **per-account lock**; merge `refresh_token` with `|| old`.
5. Stream return shape like youmind/codex: `{ success, stream, tokensUsed: 0, ... }` — no `get creditsUsed()` getter hacks.
6. Proactive refresh when `grokCliNeedsProactiveRefresh` before upstream chat.
7. On dead classify: return error string that includes `invalid_grant`/`revoked` and does **not** look like a recoverable `"401"` loop forever after permanent fail (prefer clear permanent message).

- [ ] **Step 1: Implement `GrokCliProvider` extending `BaseProvider`**

Implement after helpers. Key structure (engineer must open `base.ts` and match exact `ProviderResult` / `ModelInfo`):

```ts
import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";

export class GrokCliProvider extends BaseProvider {
  name = "grok-cli";
  override nativeFormat: "openai" | "anthropic" = "openai";
  override isFallback = false;

  /** Per-account in-flight refresh (S2). */
  private refreshLocks = new Map<number, Promise<{ success: boolean; tokens?: string; error?: string }>>();

  supportedModels: ModelInfo[] = [
    {
      id: "grok-4.5",
      object: "model",
      created: Date.now(),
      owned_by: "grok-cli",
      context_window: 256000,
      max_output: 16000,
      // 1 credit per token → local 2M budget tracks total_tokens 1:1
      creditUnit: "token",
      creditRate: 1,
      creditSource: "estimated",
    },
  ];

  override ownsModel(model: string): boolean {
    return grokCliOwnsModel(model);
  }

  private getTokens(account: Account): GrokCliTokens | null {
    try {
      const raw = typeof account.tokens === "string" ? JSON.parse(account.tokens as any) : account.tokens;
      if (!raw?.access_token) return null;
      return { ...raw, email: raw.email || account.email } as GrokCliTokens;
    } catch {
      return null;
    }
  }

  private stripUnsupportedTools(request: ChatCompletionRequest): ChatCompletionRequest {
    if (!request.tools?.length) return request;
    const cleaned = request.tools.filter((t: any) => !(t && typeof t === "object" && t.type === "custom"));
    if (cleaned.length === request.tools.length) return request;
    return { ...request, tools: cleaned };
  }

  /**
   * Ensure tokens are fresh enough. Returns possibly updated tokens JSON string
   * for caller to attach as result.tokens when used.
   */
  private async ensureFreshTokens(account: Account): Promise<{
    account: Account;
    tokensJson?: string;
    error?: string;
    dead?: boolean;
  }> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) return { account, error: "No access_token for grok-cli account", dead: true };
    if (!grokCliNeedsProactiveRefresh(tokens)) return { account };

    const refreshed = await this.refreshToken(account);
    if (!refreshed.success || !refreshed.tokens) {
      const dead = /invalid_grant|revoked|unknown refresh/i.test(refreshed.error || "");
      return { account, error: refreshed.error || "refresh failed", dead };
    }
    const parsed = JSON.parse(refreshed.tokens);
    return {
      account: { ...account, tokens: parsed } as Account,
      tokensJson: refreshed.tokens,
    };
  }

  private async upstreamChat(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<{ response: Response; tokens: GrokCliTokens }> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) throw new Error("No access_token for grok-cli account");

    const req = this.stripUnsupportedTools(request);
    const model = resolveGrokCliUpstreamModel(req.model);
    const body = { ...req, model, stream: !!req.stream };

    const response = await this.fetchWithTimeout(
      `${GROK_CLI_UPSTREAM_BASE}/chat/completions`,
      {
        method: "POST",
        headers: buildGrokCliHeaders({ ...tokens, email: account.email }, model),
        body: JSON.stringify(body),
      },
      config.providerRequestTimeoutMs
    );
    return { response, tokens };
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const nonStreamReq = { ...request, stream: false };
    let working = account;
    let persistedTokens: string | undefined;

    const fresh = await this.ensureFreshTokens(working);
    if (fresh.error && fresh.dead && !this.getTokens(working)?.access_token) {
      return { success: false, error: fresh.error };
    }
    if (fresh.tokensJson) {
      working = fresh.account;
      persistedTokens = fresh.tokensJson;
    }

    let { response } = await this.upstreamChat(working, nonStreamReq);

    // one-shot auth recovery (S7)
    if (response.status === 401) {
      const peek = await response.clone().text().catch(() => "");
      const kind = classifyGrokCliError(401, peek);
      if (kind === "dead") {
        return { success: false, error: `Grok CLI dead: ${peek.slice(0, 200)}` };
      }
      const refreshed = await this.refreshToken(working);
      if (refreshed.success && refreshed.tokens) {
        persistedTokens = refreshed.tokens;
        working = { ...working, tokens: JSON.parse(refreshed.tokens) } as Account;
        ({ response } = await this.upstreamChat(working, nonStreamReq));
      } else {
        const err = refreshed.error || "refresh failed";
        const dead = /invalid_grant|revoked|unknown refresh/i.test(err);
        return {
          success: false,
          error: dead ? `Grok CLI dead: ${err}` : `Grok CLI auth: ${err}`,
        };
      }
    }

    const text = await response.text();
    const kind = classifyGrokCliError(response.status, text);
    if (!response.ok) {
      return {
        success: false,
        error: `Grok CLI HTTP ${response.status}: ${text.slice(0, 300)}`,
        quotaExhausted: kind === "exhausted",
        ...(persistedTokens ? { tokens: JSON.parse(persistedTokens) } : {}),
      };
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return { success: false, error: "Invalid JSON from Grok CLI upstream" };
    }

    const usage = data.usage || {};
    const total =
      Number(usage.total_tokens) ||
      Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0) ||
      this.estimateMessagesTokens(request.messages);

    const promptTokens = Number(usage.prompt_tokens) || 0;
    const completionTokens = Number(usage.completion_tokens) || 0;

    const resp: ChatCompletionResponse = {
      id: data.id || this.generateId(),
      object: "chat.completion",
      created: data.created || Math.floor(Date.now() / 1000),
      model: request.model,
      choices: data.choices || [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: total,
      },
    };

    return {
      success: true,
      response: resp,
      promptTokens,
      completionTokens,
      tokensUsed: total,
      creditsUsed: total, // creditRate=1, unit=token → 2M budget
      creditSource: "estimated",
      ...(persistedTokens ? { tokens: JSON.parse(persistedTokens) } : {}),
    };
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const streamReq = { ...request, stream: true };
    let working = account;
    let persistedTokens: string | undefined;

    const fresh = await this.ensureFreshTokens(working);
    if (fresh.tokensJson) {
      working = fresh.account;
      persistedTokens = fresh.tokensJson;
    }

    let { response } = await this.upstreamChat(working, streamReq);

    if (response.status === 401) {
      const peek = await response.clone().text().catch(() => "");
      const kind = classifyGrokCliError(401, peek);
      if (kind === "dead") {
        return { success: false, error: `Grok CLI dead: ${peek.slice(0, 200)}` };
      }
      const refreshed = await this.refreshToken(working);
      if (refreshed.success && refreshed.tokens) {
        persistedTokens = refreshed.tokens;
        working = { ...working, tokens: JSON.parse(refreshed.tokens) } as Account;
        ({ response } = await this.upstreamChat(working, streamReq));
      } else {
        return { success: false, error: `Grok CLI auth: ${refreshed.error || "refresh failed"}` };
      }
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      const kind = classifyGrokCliError(response.status, text);
      return {
        success: false,
        error: `Grok CLI stream HTTP ${response.status}: ${text.slice(0, 300)}`,
        quotaExhausted: kind === "exhausted",
        ...(persistedTokens ? { tokens: JSON.parse(persistedTokens) } : {}),
      };
    }

    // Pass-through SSE; edge layer extracts usage for credits
    return {
      success: true,
      stream: response.body,
      promptTokens: 0,
      completionTokens: 0,
      tokensUsed: 0,
      ...(persistedTokens ? { tokens: JSON.parse(persistedTokens) } : {}),
    };
  }

  async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const existing = this.refreshLocks.get(account.id);
    if (existing) return existing;

    const p = this.doRefreshToken(account).finally(() => {
      this.refreshLocks.delete(account.id);
    });
    this.refreshLocks.set(account.id, p);
    return p;
  }

  private async doRefreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens?.refresh_token) return { success: false, error: "No refresh_token" };

    try {
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: tokens.client_id || GROK_CLI_CLIENT_ID,
        refresh_token: tokens.refresh_token,
      });

      const response = await this.fetchWithTimeout(
        GROK_CLI_TOKEN_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": "grok-cli/proxy",
          },
          body: form.toString(),
        },
        15000
      );

      const text = await response.text();
      if (!response.ok) {
        const kind = classifyGrokCliError(response.status, text);
        return {
          success: false,
          error: kind === "dead"
            ? `invalid_grant: ${text.slice(0, 200)}`
            : `Refresh failed (${kind || response.status}): ${text.slice(0, 200)}`,
        };
      }

      const data = JSON.parse(text);
      if (!data.access_token) return { success: false, error: "No access_token in refresh response" };

      const expiresIn = Number(data.expires_in) || 21600;
      const next: GrokCliTokens = {
        ...tokens,
        access_token: data.access_token,
        // S5: never clobber RT with null
        refresh_token: data.refresh_token || tokens.refresh_token,
        id_token: data.id_token || tokens.id_token,
        expires_at: Math.floor(Date.now() / 1000) + expiresIn,
        email: tokens.email || account.email,
      };

      if (next.id_token) {
        try {
          const normalized = normalizeGrokCliCpa({
            email: next.email,
            access_token: next.access_token,
            refresh_token: next.refresh_token,
            id_token: next.id_token,
          });
          next.team_id = normalized.team_id || next.team_id;
          next.sub = normalized.sub || next.sub;
        } catch { /* keep old */ }
      }

      return { success: true, tokens: JSON.stringify(next) };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!(tokens?.access_token && tokens?.refresh_token);
  }

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    // Local 2M budget via schema quota* fields (S9)
    const limit = Number(account.quotaLimit) > 0 ? Number(account.quotaLimit) : GROK_CLI_TOKEN_LIMIT;
    const remainingRaw = account.quotaRemaining;
    const remaining = typeof remainingRaw === "number" ? remainingRaw : limit;
    const used = Math.max(0, limit - remaining);
    return {
      success: true,
      quota: { limit, remaining: Math.max(0, remaining), used, resetAt: null },
    };
  }
}

export const grokCliProvider = new GrokCliProvider();
```

**Important:** After writing, re-read `ProviderResult` / `ModelInfo` in `base.ts`. Only set fields that exist. Match kiro/youmind success/error shapes.

- [ ] **Step 2: Quick typecheck filter**

```powershell
cd C:\Users\Administrator\etteum-pool
bunx tsc --noEmit -p tsconfig.json 2>&1 | Select-String "grok-cli"
```

Expected: no errors in `grok-cli.ts`.

- [ ] **Step 3: Re-run unit tests**

```powershell
bun test src/proxy/providers/grok-cli.test.ts
```

- [ ] **Step 4: Commit**

```powershell
git add src/proxy/providers/grok-cli.ts
git commit -m "feat(grok-cli): implement GrokCliProvider with safe refresh locks"
```

---

### Task 3: Register provider in registry

**Files:**
- Modify: `src/proxy/providers/registry.ts`

- [ ] **Step 1: Wire provider**

```ts
import { GrokCliProvider } from "./grok-cli";

const grokCli = new GrokCliProvider();

const PROVIDER_ORDER = [
  gitlabDuo,
  canva,
  qoder,
  codex,
  kiroPro,
  youmind,
  grokCli, // owns grok-4.5 / grok-cli-*
  byok,
  codebuddyChina,
  codebuddy,
  kiro,
] as const;

export const providers = {
  // ...existing
  "grok-cli": grokCli,
} as const;
```

- [ ] **Step 2: Smoke route test**

```powershell
bun -e "import { getProviderForModel, getAllModels } from './src/proxy/providers/registry.ts'; console.log(getProviderForModel('grok-4.5')); console.log(getAllModels().filter(m => m.id.includes('grok')).map(m => m.id));"
```

Expected:
```
grok-cli
[ "grok-4.5" ]
```

- [ ] **Step 3: Commit**

```powershell
git add src/proxy/providers/registry.ts
git commit -m "feat(grok-cli): register provider in PROVIDER_ORDER"
```

---

### Task 4: Import API — bulk CPA JSON (safe fields)

**Files:**
- Modify: `src/api/accounts.ts`
- Pattern: YouMind branch around `POST /api/accounts`

- [ ] **Step 1: Add import route**

Import helpers:
```ts
import { normalizeGrokCliCpa, GROK_CLI_TOKEN_LIMIT } from "../proxy/providers/grok-cli";
```

Add **`POST /api/accounts/grok-cli/import`**:
- Body: `{ accounts?: any[]; text?: string }` (JSON array or NDJSON)
- For each item: `normalizeGrokCliCpa` → upsert by `(provider=grok-cli, email)`
- Tokens JSON: access/refresh/id/team/sub/client_id/email/expires_at if any
- **Schema:** `quotaLimit: GROK_CLI_TOKEN_LIMIT`, `quotaRemaining: existing ?? GROK_CLI_TOKEN_LIMIT` (S9)
- Password: `encrypt("grok-cli-token-auth")` (not empty string)
- `status: "active"`, `enabled: true`
- Optional (recommended): after insert, call provider `refreshToken` once; if dead → set `status: "error"` + message (do not leave known-dead RT in active pool)
- `pool.invalidate("grok-cli")` + broadcast bulk event

Extend create provider union with `"grok-cli"`.

- [ ] **Step 2: Manual API test (dummy tokens)**

```powershell
$key = (Select-String -Path .env -Pattern '^API_KEY=(.+)$').Matches.Groups[1].Value
$body = @{
  accounts = @(
    @{
      email = "test-grok@example.com"
      access_token = "test-access"
      refresh_token = "test-refresh"
    }
  )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri "http://localhost:1930/api/accounts/grok-cli/import" `
  -Method POST -Headers @{ Authorization = "Bearer $key"; "Content-Type" = "application/json" } `
  -Body $body
```

Expected: `imported: 1`, account `provider: grok-cli`, quota fields 2M.

- [ ] **Step 3: Commit**

```powershell
git add src/api/accounts.ts
git commit -m "feat(grok-cli): add CPA JSON bulk import API"
```

---

### Task 5: Dashboard — provider tab + import UI

**Files:**
- Modify: `dashboard/src/lib/api.ts`
- Modify: `dashboard/src/pages/Accounts.tsx`
- Modify labels in `AccountList.tsx` / `Settings.tsx` / `Requests.tsx` if hardcoded

- [ ] **Step 1: API helper + Provider type**

```ts
export async function importGrokCliAccounts(payload: { accounts?: any[]; text?: string }) {
  return fetchApi(`/api/accounts/grok-cli/import`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
```

Extend `Provider` union with `"grok-cli"`.

- [ ] **Step 2: Accounts page**

1. Add `"grok-cli"` to `providers` array  
2. `labelProvider`: `grok-cli` → `"Grok CLI"`  
3. Add dialog mode: Import JSON only (textarea), not email/password  
4. Submit via `importGrokCliAccounts({ text })`  
5. Placeholder shows flat + nested CPA examples  

- [ ] **Step 3: Rebuild dashboard**

```powershell
cd C:\Users\Administrator\etteum-pool\dashboard
bun run build
cd ..
.\etteum.ps1 restart
```

- [ ] **Step 4: Manual UI check** — Accounts → Grok CLI → Import JSON → row appears

- [ ] **Step 5: Commit**

```powershell
git add dashboard/src/pages/Accounts.tsx dashboard/src/lib/api.ts dashboard/src/pages/AccountList.tsx
# plus any label files touched
git commit -m "feat(grok-cli): dashboard import UI and provider labels"
```

---

### Task 6: Credit decrement + exhausted path (verify, patch only if needed)

**Files:**
- Inspect: `src/proxy/index.ts`, `src/proxy/router.ts`
- Modify only if allowlist skips `grok-cli`

- [ ] **Step 1: Confirm generic path**

`computeCredits` + `pool.decrementQuota` already run for non-qoder when `quotaRemaining > 0`.  
Provider must return `creditsUsed` / `tokensUsed` (Task 2).  
Import must set `quotaRemaining` to 2M (Task 4).

- [ ] **Step 2: Confirm `quotaExhausted` → `pool.markExhausted`** in router (already true for all providers).

- [ ] **Step 3: Live smoke with real CPA (if available)**

```powershell
$key = (Select-String -Path .env -Pattern '^API_KEY=(.+)$').Matches.Groups[1].Value
Invoke-RestMethod http://localhost:1930/v1/models -Headers @{ Authorization = "Bearer $key" }
# expect grok-4.5

Invoke-RestMethod http://localhost:1930/v1/chat/completions `
  -Method POST -Headers @{ Authorization = "Bearer $key"; "Content-Type" = "application/json" } `
  -Body (@{ model = "grok-4.5"; messages = @(@{ role = "user"; content = "ping" }); max_tokens = 16 } | ConvertTo-Json -Depth 5)
```

Expected: 200, content, `quotaRemaining` drops.

- [ ] **Step 4: Commit only if code changed**

```powershell
git add src/proxy/index.ts src/proxy/router.ts
git commit -m "feat(grok-cli): ensure quota decrement and exhausted handling"
```

---

### Task 7: Warmup path verification

**Files:**
- Inspect: `src/auth/warmup-runner.ts`

- [ ] **Step 1:** Confirm warmup uses generic `provider.healthCheck` → `validateAccount` + `fetchQuota` (quota* fields). No special-case required if provider registered.

- [ ] **Step 2:** Manual warmup one grok-cli account → stays/returns `active` if tokens valid.

- [ ] **Step 3:** Commit only if code changed.

Optional later (not MVP): mini chat warmup `max_tokens: 4` like grok-cli-proxy — **never** run full-pool serial mini-chat on thousands of accounts without concurrency limits.

---

### Task 8: E2E checklist + optional docs

- [ ] **Step 1: E2E checklist (run all that apply)**

| # | Check | Pass? |
|---|-------|-------|
| 1 | `bun test src/proxy/providers/grok-cli.test.ts` | |
| 2 | Import flat CPA via API | |
| 3 | Import nested `{email,tokens}` | |
| 4 | Duplicate email updates tokens (no second row) | |
| 5 | `GET /v1/models` includes `grok-4.5` | |
| 6 | Non-stream chat works | |
| 7 | Stream chat works | |
| 8 | Dashboard Grok CLI import UI | |
| 9 | Warmup does not crash | |
| 10 | 401 path: refresh + persist (mangle access_token, keep valid RT) | |
| 11 | Concurrent refresh same account: only one network refresh (lock) | |
| 12 | `quotaRemaining` decreases after chat | |
| 13 | 403 exhausted → account status exhausted, RT still present | |

- [ ] **Step 2: README one-liner (optional)**

```markdown
| **Grok CLI** | CPA token import | xAI Grok CLI (`grok-4.5`), 2M token budget/account, safe concurrent refresh |
```

- [ ] **Step 3: Final commit if docs touched**

```powershell
git add README.md
git commit -m "docs: document Grok CLI provider"
```

---

## Phase 2 (optional follow-up — not blocking MVP)

Only after Phase 1 E2E green:

1. **Background refresh job** for `provider=grok-cli` where `expires_at` within lead window — concurrency 50–100, skip `error`/`exhausted` as needed, stop on dead.
2. **Admin bulk refresh** "expires soon only" (never default full 5k serial).
3. **Import concurrency** hard cap 20–30 with progress events.

Do **not** implement full-pool force-refresh as default.

---

## Spec coverage (self-review)

| Design requirement | Task |
|--------------------|------|
| Native provider | 2–3 |
| Import token JSON only | 1, 4, 5 |
| OpenAI chat + stream | 2 |
| Safe OAuth refresh (lock, persist, no RT clobber) | 2 (S1–S8) |
| Headers CLI-specific | 1–2 |
| 2M local quota via quotaLimit/Remaining | 2, 4, 6 |
| Model `grok-4.5` | 2–3 |
| Dashboard import | 5 |
| Registry order | 3 |
| Tests | 1 |
| Warmup | 7 |
| Thousands-account safety model | Safety section + Task 2 |
| No browser login / no Python sidecar | Out of scope |

**Type consistency:**
- Provider name always `"grok-cli"` (hyphen)
- Tokens: snake_case in JSON (`GrokCliTokens`)
- Import: `POST /api/accounts/grok-cli/import`
- Exhausted flag: `quotaExhausted`
- Quota columns: `quotaLimit` / `quotaRemaining`

**Placeholder scan:** none intentional. Match real `base.ts` field names.

---

## Execution notes for Windows

- Server: `cd C:\Users\Administrator\etteum-pool; .\etteum.ps1 restart`
- Bun: prefer `C:\Users\Administrator\.bun\bin\bun.exe` if shim fails
- Dashboard: `cd dashboard; bun run build`
- API key: from `.env` `API_KEY=...`

## Out of scope

- Browser OAuth for xAI
- Porting grok-cli-proxy Python dashboard
- Making CLIProxyAPI or grok2api the primary runtime
- Relay/edge rewrite
- Multiple Grok models beyond `grok-4.5` unless live `/v1/models` proves more
- "modif created_at" hacks

---

## Done definition (MVP)

MVP is done when **all** are true with fresh evidence:

1. Unit tests for normalize/headers/classify pass  
2. Real or dummy CPA import works (API + dashboard)  
3. `POST /v1/chat/completions` with `model: "grok-4.5"` returns completion through etteum (with real CPA)  
4. Account in pool with `quotaLimit`/`quotaRemaining` tracking  
5. Refresh path: lock + persist `result.tokens` + never clobber RT (code review + optional concurrent test)  
6. 401 dead vs auth classification does not mass-mark healthy accounts  

**Subagent execution:** Use `superpowers:subagent-driven-development`. One task per subagent, fresh context, review between tasks. Do not skip Safety rules S1–S10.
)
