import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";
import {
  isDeadErrorMessage,
  isMissingCredentialMessage,
  isPermanentRevocation,
  parseExpiresAtSec,
} from "../account-health";
import type { ProveMode, SessionProveResult } from "../session-prove";
import {
  DEFAULT_GROK_CLI_REFRESH_LEAD_SEC,
  getCachedGrokCliRuntimeSettings,
} from "./grok-cli-settings";

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
/** Default proactive-refresh lead (seconds). Runtime may override via settings cache. */
export const GROK_CLI_REFRESH_LEAD_SEC = DEFAULT_GROK_CLI_REFRESH_LEAD_SEC;
/** Image generate/edit via Responses API needs a longer budget than chat. */
export const GROK_CLI_IMAGE_TIMEOUT_MS =
  Number(process.env.GROK_CLI_IMAGE_TIMEOUT_MS) || 180_000;

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

export type GrokCliEffort = "low" | "medium" | "high" | null;

/** Catalog IDs exposed on /v1/models (9router-style gcli/* effort aliases). */
export const GROK_CLI_CATALOG_IDS = [
  "gcli/grok-4.5",
  "gcli/grok-4.5-high",
  "gcli/grok-4.5-medium",
  "gcli/grok-4.5-low",
] as const;

/**
 * Map client model id → upstream model + optional reasoning effort.
 * All gcli/grok-4.5* aliases hit the same xAI model; effort suffixes only set reasoning_effort.
 */
export function parseGrokCliModelId(model: string): {
  upstream: string;
  effort: GrokCliEffort;
  bare: string;
} {
  let m = model.trim();
  const lower = m.toLowerCase();
  if (lower.startsWith("gcli/")) m = m.slice("gcli/".length);
  else if (lower.startsWith("grok-cli/")) m = m.slice("grok-cli/".length);
  else if (lower.startsWith("grok-cli-")) m = m.slice("grok-cli-".length);

  const bareLower = m.toLowerCase();
  let effort: GrokCliEffort = null;
  let bare = m;
  if (bareLower.endsWith("-high")) {
    effort = "high";
    bare = m.slice(0, -"-high".length);
  } else if (bareLower.endsWith("-medium")) {
    effort = "medium";
    bare = m.slice(0, -"-medium".length);
  } else if (bareLower.endsWith("-low")) {
    effort = "low";
    bare = m.slice(0, -"-low".length);
  }

  // Single physical upstream model for this provider catalog
  const upstream = "grok-4.5";
  return { upstream, effort, bare: bare || upstream };
}

export function resolveGrokCliUpstreamModel(model: string): string {
  return parseGrokCliModelId(model).upstream;
}

export function grokCliOwnsModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  // 9router-style catalog
  if (m === "gcli/grok-4.5" || m === "gcli/grok-4.5-high" || m === "gcli/grok-4.5-medium" || m === "gcli/grok-4.5-low") {
    return true;
  }
  if (m === "gcli/grok-image" || m === "grok-image") return true;
  if (m.startsWith("gcli/")) {
    const rest = m.slice("gcli/".length);
    return rest === "grok-4.5" || rest.startsWith("grok-4.5-") || rest === "grok-build" || rest.startsWith("grok-4") || rest === "grok-image";
  }
  // bare + legacy prefixes (compat with early etteum clients)
  if (m === "grok-4.5" || m.startsWith("grok-4.5-") || m.startsWith("grok-4")) return true;
  if (m.startsWith("grok-cli/") || m.startsWith("grok-cli-")) {
    const rest = m.startsWith("grok-cli/") ? m.slice("grok-cli/".length) : m.slice("grok-cli-".length);
    return rest === "grok-4.5" || rest.startsWith("grok-4.5-") || rest.startsWith("grok-");
  }
  return false;
}

// Image pure helpers live in grok-cli-image.ts; re-export for existing imports/tests.
export {
  stripGrokCliDataUrlPrefix,
  normalizeGrokCliImageRef,
  collectGrokCliImageRefs,
  extractGrokCliImageGenerationResults,
  normalizeGrokCliUsage,
  emptyGrokCliUsage,
  addGrokCliUsage,
  type GrokCliUsageNormalized,
  type GrokCliImageResult,
  type GrokCliImageRequestOpts,
} from "./grok-cli-image";

import {
  extractGrokCliImageGenerationResults,
  normalizeGrokCliUsage,
  emptyGrokCliUsage,
  addGrokCliUsage,
  type GrokCliImageResult,
  type GrokCliImageRequestOpts,
  type GrokCliUsageNormalized,
} from "./grok-cli-image";

export function buildGrokCliHeaders(
  tokens: Pick<GrokCliTokens, "access_token" | "email" | "team_id" | "sub" | "user_id" | "principal_id"> & { email?: string },
  model: string,
  clientVersion = GROK_CLI_CLIENT_VERSION
): Record<string, string> {
  const ver = clientVersion;
  // Bun/fetch Headers merges case-insensitive keys into a comma list.
  // Sending both X-XAI-Token-Auth and x-xai-token-auth becomes
  // "xai-grok-cli, xai-grok-cli" → upstream reports x_xai_token_auth=unknown.
  // One header is enough (HTTP headers are case-insensitive).
  const h: Record<string, string> = {
    Authorization: `Bearer ${tokens.access_token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `grok-pager/${ver} grok-shell/${ver} (linux; x86_64)`,
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

/** Soft client-facing string — do not dump multi-line center bodies for credit death. */
export const GROK_CLI_CREDIT_SOFT_ERROR = "Grok CLI credits exhausted";

/**
 * Classify center chat/image failures.
 * Live free/personal path returns HTTP 402 + code personal-team-blocked:spending-limit
 * (hyphenated, not "spending limit") and "run out of credits" — not only 403.
 */
export function classifyGrokCliError(status: number, body: string): GrokCliErrorKind {
  const low = (body || "").toLowerCase();
  // Prefer dead if body clearly says revoked even with 403-ish wording
  if (low.includes("invalid_grant") || low.includes("revoked") || low.includes("unknown refresh")) {
    if (status === 401 || status === 403) return "dead";
    if (status !== 402) return "dead";
  }
  if (
    status === 402 ||
    status === 403 ||
    low.includes("spending limit") ||
    low.includes("spending-limit") ||
    low.includes("personal-team-blocked") ||
    low.includes("credits are exhausted") ||
    low.includes("run out of credits") ||
    low.includes("free-usage-exhausted") ||
    low.includes("need a grok subscription") ||
    (status === 429 && /tokens\s*\(actual\/limit\)|free-usage|quota|credit/i.test(low)) ||
    (low.includes("quota") && /exhaust|exceed|limit|spent|usage/i.test(low))
  ) {
    return "exhausted";
  }
  if (status === 401) {
    return "auth";
  }
  if (low.includes("invalid_grant") || low.includes("revoked")) return "dead";
  return null;
}

type HeaderLike =
  | Headers
  | Record<string, string | string[] | undefined | null>
  | { get?(name: string): string | null | undefined };

function headerGet(headers: HeaderLike | null | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    const v = (headers as Headers).get(name);
    return v == null ? undefined : String(v);
  }
  const rec = headers as Record<string, string | string[] | undefined | null>;
  const direct = rec[name] ?? rec[name.toLowerCase()] ?? rec[name.toUpperCase()];
  if (direct == null) {
    // case-insensitive scan for plain objects
    const want = name.toLowerCase();
    for (const [k, v] of Object.entries(rec)) {
      if (k.toLowerCase() === want) {
        return Array.isArray(v) ? v[0] : v == null ? undefined : String(v);
      }
    }
    return undefined;
  }
  return Array.isArray(direct) ? direct[0] : String(direct);
}

function headerInt(headers: HeaderLike | null | undefined, name: string): number | undefined {
  const raw = headerGet(headers, name);
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

export type GrokCliRateLimitSnapshot = {
  limitTokens?: number;
  remainingTokens?: number;
  limitRequests?: number;
  remainingRequests?: number;
};

/** Parse cli-chat-proxy x-ratelimit-* headers (center free-window truth). */
export function parseGrokCliRateLimitHeaders(
  headers: HeaderLike | null | undefined
): GrokCliRateLimitSnapshot {
  const out: GrokCliRateLimitSnapshot = {};
  const limitTokens = headerInt(headers, "x-ratelimit-limit-tokens");
  const remainingTokens = headerInt(headers, "x-ratelimit-remaining-tokens");
  const limitRequests = headerInt(headers, "x-ratelimit-limit-requests");
  const remainingRequests = headerInt(headers, "x-ratelimit-remaining-requests");
  if (limitTokens != null) out.limitTokens = limitTokens;
  if (remainingTokens != null) out.remainingTokens = remainingTokens;
  if (limitRequests != null) out.limitRequests = limitRequests;
  if (remainingRequests != null) out.remainingRequests = remainingRequests;
  return out;
}

/**
 * Parse 429 free-usage body: `tokens (actual/limit): 1053503/1000000`.
 * remaining is max(0, limit - actual) — can be 0 when actual > limit.
 */
export function parseGrokCliExhaustedBody(
  body: string
): { actual: number; limit: number; remaining: number } | null {
  const m = /tokens\s*\(actual\/limit\)\s*:\s*(\d+)\s*\/\s*(\d+)/i.exec(body || "");
  if (!m) return null;
  const actual = Number(m[1]);
  const limit = Number(m[2]);
  if (!Number.isFinite(actual) || !Number.isFinite(limit) || limit <= 0) return null;
  return { actual, limit, remaining: Math.max(0, limit - actual) };
}

/** Build quota snapshot from center headers and/or exhausted body. */
export function quotaFromGrokCliCenterSignals(opts: {
  headers?: HeaderLike | null;
  body?: string;
  status?: number;
}): {
  limit: number;
  remaining: number;
  used: number;
  resetAt: null;
  source: string;
  exhausted: boolean;
} | null {
  const rl = parseGrokCliRateLimitHeaders(opts.headers);
  const exhaustedBody = parseGrokCliExhaustedBody(opts.body || "");
  const kind = classifyGrokCliError(opts.status ?? 0, opts.body || "");

  if (exhaustedBody) {
    return {
      limit: exhaustedBody.limit,
      remaining: exhaustedBody.remaining,
      used: exhaustedBody.actual,
      resetAt: null,
      source: "upstream-body",
      exhausted: true,
    };
  }

  if (rl.limitTokens != null || rl.remainingTokens != null) {
    const limit =
      rl.limitTokens != null && rl.limitTokens > 0
        ? rl.limitTokens
        : GROK_CLI_TOKEN_LIMIT;
    const remaining =
      rl.remainingTokens != null
        ? Math.max(0, rl.remainingTokens)
        : limit;
    const used = Math.max(0, limit - remaining);
    return {
      limit,
      remaining,
      used,
      resetAt: null,
      source: "upstream-headers",
      exhausted: kind === "exhausted" || remaining <= 0,
    };
  }

  if (kind === "exhausted") {
    // 402 spending-limit: center says unusable — don't invent remaining from local 2M.
    return {
      limit: GROK_CLI_TOKEN_LIMIT,
      remaining: 0,
      used: GROK_CLI_TOKEN_LIMIT,
      resetAt: null,
      source: "upstream-exhausted",
      exhausted: true,
    };
  }

  return null;
}

/**
 * True when this account must not be selected for traffic.
 * Includes permanent IdP death AND missing credentials.
 * For WarmUp short-circuit / permanent latch, use isPermanentRevocation only —
 * missing-creds must stay diagnosable and reauthable.
 */
export function isGrokCliDeadError(error?: string | null): boolean {
  return isDeadErrorMessage(error);
}

/** IdP revocation only (invalid_grant) — reauth/re-farm. */
export function isGrokCliPermanentRevocation(error?: string | null): boolean {
  return isPermanentRevocation(error);
}

export type GrokAuthClass = "permanent" | "missing" | "auth";

/**
 * Single classifier for refresh/auth failures.
 * permanent → WarmUp latch / reauth-or-farm
 * missing  → unusable for traffic, still reauthable (no "Grok CLI dead:" latch)
 * auth     → transient / generic auth error
 */
export function classifyGrokAuthFailure(error?: string | null): GrokAuthClass {
  if (isPermanentRevocation(error)) return "permanent";
  if (isMissingCredentialMessage(error)) return "missing";
  if (isDeadErrorMessage(error)) return "missing"; // belt: dead union without permanent
  return "auth";
}

/**
 * Prefix permanent IdP death only. Never wrap missing-credential messages —
 * "Grok CLI dead:" is itself an isPermanentRevocation match, so formatting
 * "no access_token" this way would latch WarmUp forever and block reauth.
 */
function formatGrokCliDeadError(detail: string): string {
  const cleaned = (detail || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!cleaned) return "Grok CLI dead: refresh token revoked";
  if (cleaned.toLowerCase().startsWith("grok cli dead:")) return cleaned;
  // Preserve missing-credential wording so isMissingCredentialMessage still matches.
  if (isMissingCredentialMessage(cleaned)) return cleaned;
  return `Grok CLI dead: ${cleaned}`;
}

/**
 * One place for error text + deadAccount flag used by ensure/require/recover.
 * deadAccount=true means "do not select for traffic"; permanent only for IdP death.
 */
export function formatGrokAuthFailure(error?: string | null): {
  error: string;
  deadAccount: boolean;
  permanent: boolean;
  kind: GrokAuthClass;
} {
  const raw = (error || "").replace(/\s+/g, " ").trim() || "refresh failed";
  const kind = classifyGrokAuthFailure(raw);
  if (kind === "permanent") {
    return {
      error: formatGrokCliDeadError(raw),
      deadAccount: true,
      permanent: true,
      kind,
    };
  }
  if (kind === "missing") {
    return { error: raw, deadAccount: true, permanent: false, kind };
  }
  return {
    error: raw.startsWith("Grok CLI auth:") ? raw : `Grok CLI auth: ${raw}`,
    deadAccount: false,
    permanent: false,
    kind,
  };
}

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
  if (expSec == null) return false; // unknown expiry: rely on 401 path
  return expSec - nowSec < leadSec;
}

type RefreshResult = { success: boolean; tokens?: string; error?: string };

export class GrokCliProvider extends BaseProvider {
  name = "grok-cli";
  override nativeFormat: "openai" | "anthropic" = "openai";
  override isFallback = false;

  /**
   * Live read from settings cache (single source of truth).
   * Key: grok_cli_max_account_retries. No dual-store apply path.
   */
  override get maxAccountRetries(): number {
    return getCachedGrokCliRuntimeSettings().maxAccountRetries;
  }

  private refreshLocks = new Map<number, Promise<RefreshResult>>();

  supportedModels: ModelInfo[] = [
    ...GROK_CLI_CATALOG_IDS.map((id) => ({
      id,
      object: "model" as const,
      created: Date.now(),
      owned_by: "grok-cli",
      context_window: 256000,
      max_output: 16000,
      thinking: id !== "gcli/grok-4.5",
      vision: true,
      creditUnit: "token" as const,
      creditRate: 1,
      creditSource: "estimated" as const,
    })),
    {
      id: "gcli/grok-image",
      object: "model" as const,
      created: Date.now(),
      owned_by: "grok-cli",
      context_window: 256000,
      max_output: 4096,
      thinking: false,
      vision: false,
      creditUnit: "image" as const,
      creditRate: 1,
      creditSource: "estimated" as const,
    },
  ];

  override ownsModel(model: string): boolean {
    return grokCliOwnsModel(model);
  }

  override getModelInfo(model: string): ModelInfo | undefined {
    const m = model.trim().toLowerCase();
    const exact = this.supportedModels.find((item) => item.id.toLowerCase() === m);
    if (exact) return exact;
    // bare grok-4.5 / legacy → default catalog entry
    if (m === "grok-4.5" || m === "gcli/grok-4.5") {
      return this.supportedModels.find((item) => item.id === "gcli/grok-4.5");
    }
    if (m.endsWith("-high")) return this.supportedModels.find((item) => item.id === "gcli/grok-4.5-high");
    if (m.endsWith("-medium")) return this.supportedModels.find((item) => item.id === "gcli/grok-4.5-medium");
    if (m.endsWith("-low")) return this.supportedModels.find((item) => item.id === "gcli/grok-4.5-low");
    return super.getModelInfo(model);
  }

  private getTokens(account: Account): GrokCliTokens | null {
    try {
      const raw = typeof account.tokens === "string" ? JSON.parse(account.tokens as string) : account.tokens;
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

  private async ensureFreshTokens(account: Account): Promise<{
    account: Account;
    tokensJson?: string;
    error?: string;
    dead?: boolean;
  }> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) {
      // Unusable for traffic, but not permanent IdP death — keep plain wording.
      const formatted = formatGrokAuthFailure("No access_token for grok-cli account");
      return {
        account,
        error: formatted.error,
        dead: formatted.deadAccount,
      };
    }
    if (!grokCliNeedsProactiveRefresh(tokens)) return { account };

    const refreshed = await this.refreshToken(account);
    if (!refreshed.success || !refreshed.tokens) {
      const formatted = formatGrokAuthFailure(refreshed.error || "refresh failed");
      return {
        account,
        error: formatted.error,
        dead: formatted.deadAccount,
      };
    }
    return {
      account: { ...account, tokens: JSON.parse(refreshed.tokens) } as Account,
      tokensJson: refreshed.tokens,
    };
  }

  /**
   * Ensure a usable session before any upstream call.
   * Never returns ok when refresh is permanently dead.
   */
  private async requireFreshSession(account: Account): Promise<
    | { ok: true; account: Account; tokensJson?: string }
    | { ok: false; error: string; deadAccount: boolean }
  > {
    const fresh = await this.ensureFreshTokens(account);
    if (fresh.dead || (fresh.error && isGrokCliDeadError(fresh.error))) {
      const formatted = formatGrokAuthFailure(fresh.error || "refresh token revoked");
      return {
        ok: false,
        error: formatted.error,
        deadAccount: true,
      };
    }
    if (fresh.error && !this.getTokens(fresh.account)?.access_token) {
      return { ok: false, error: fresh.error, deadAccount: false };
    }
    return {
      ok: true,
      account: fresh.tokensJson ? fresh.account : account,
      tokensJson: fresh.tokensJson,
    };
  }

  private failChat(
    error: string,
    opts?: { deadAccount?: boolean; quotaExhausted?: boolean; tokens?: unknown }
  ): ProviderResult {
    return {
      success: false,
      error,
      deadAccount: opts?.deadAccount,
      quotaExhausted: opts?.quotaExhausted,
      ...(opts?.tokens !== undefined ? { tokens: opts.tokens } : {}),
    };
  }

  private failImage(
    error: string,
    opts?: { deadAccount?: boolean; quotaExhausted?: boolean; tokens?: unknown }
  ): GrokCliImageResult {
    return {
      success: false,
      error,
      deadAccount: opts?.deadAccount,
      quotaExhausted: opts?.quotaExhausted,
      ...(opts?.tokens !== undefined ? { tokens: opts.tokens } : {}),
    };
  }

  /**
   * Shared 401 / refresh failure path for chat + image.
   * Returns a failure result, or a refreshed account to retry upstream.
   */
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

  private async upstreamChat(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<{ response: Response; tokens: GrokCliTokens }> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) throw new Error("No access_token for grok-cli account");

    const req = this.stripUnsupportedTools(request);
    const parsed = parseGrokCliModelId(req.model);
    const model = parsed.upstream;
    const body: Record<string, unknown> = {
      ...req,
      model,
      stream: !!req.stream,
    };
    // Effort aliases set reasoning_effort unless client already sent one
    if (parsed.effort && body.reasoning_effort == null && (body as any).reasoningEffort == null) {
      body.reasoning_effort = parsed.effort;
    }

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

  /**
   * Free CLI image path: Responses API + built-in image_generation tool
   * (not paid api.x.ai /v1/images/*).
   */
  private async upstreamImageResponses(
    account: Account,
    opts: { prompt: string; images?: string[]; model?: string }
  ): Promise<{ response: Response; tokens: GrokCliTokens }> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) throw new Error("No access_token for grok-cli account");

    const model = resolveGrokCliUpstreamModel(opts.model || "gcli/grok-4.5");
    const content: Array<Record<string, string>> = [];
    for (const imageUrl of opts.images || []) {
      content.push({ type: "input_image", image_url: imageUrl });
    }
    const mode = (opts.images?.length || 0) > 0 ? "Edit" : "Generate";
    content.push({
      type: "input_text",
      text: `${mode} an image: ${opts.prompt}. Use the image_generation tool.`,
    });

    const body = {
      model,
      input: [{ role: "user", content }],
      tools: [{ type: "image_generation" }],
      stream: false,
      reasoning: { effort: "low" },
      max_output_tokens: 1024,
    };

    const response = await this.fetchWithTimeout(
      `${GROK_CLI_UPSTREAM_BASE}/responses`,
      {
        method: "POST",
        headers: buildGrokCliHeaders({ ...tokens, email: account.email }, model),
        body: JSON.stringify(body),
      },
      GROK_CLI_IMAGE_TIMEOUT_MS
    );
    return { response, tokens };
  }

  private async runImageOnce(
    account: Account,
    opts: { prompt: string; images?: string[]; model?: string }
  ): Promise<GrokCliImageResult> {
    let working = account;
    let persistedTokens: string | undefined;

    const session = await this.requireFreshSession(working);
    if (!session.ok) {
      return this.failImage(session.error, { deadAccount: session.deadAccount });
    }
    working = session.account;
    persistedTokens = session.tokensJson;

    let { response } = await this.upstreamImageResponses(working, opts);

    if (response.status === 401) {
      const peek = await response.clone().text().catch(() => "");
      const auth = await this.handleAuthFailure(working, 401, peek);
      if (auth.kind === "dead") {
        return this.failImage(auth.error, { deadAccount: true });
      }
      if (auth.kind === "auth_failed") {
        return this.failImage(auth.error, { deadAccount: auth.deadAccount });
      }
      persistedTokens = auth.tokensJson;
      working = auth.account;
      ({ response } = await this.upstreamImageResponses(working, opts));
    }

    const text = await response.text();
    const kind = classifyGrokCliError(response.status, text);
    const parsedTokens = this.parsePersistedTokens(persistedTokens);
    if (!response.ok) {
      return this.failImage(
        kind === "exhausted"
          ? GROK_CLI_CREDIT_SOFT_ERROR
          : `Grok CLI image HTTP ${response.status}: ${text.slice(0, 300)}`,
        {
          quotaExhausted: kind === "exhausted",
          deadAccount: kind === "dead",
          tokens: parsedTokens,
        }
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return this.failImage("Invalid JSON from Grok CLI image upstream");
    }

    const imagesB64 = extractGrokCliImageGenerationResults(data);
    if (imagesB64.length === 0) {
      return this.failImage("No image_generation_call result in upstream response", {
        tokens: parsedTokens,
      });
    }

    const usage = normalizeGrokCliUsage((data as any)?.usage);
    return {
      success: true,
      imagesB64,
      usage,
      ...(parsedTokens !== undefined ? { tokens: parsedTokens } : {}),
    };
  }

  /**
   * Free CLI Responses image_generation tool.
   * When `images` is non-empty → edit; otherwise generate.
   * Sequential upstream calls when n > 1; usage is summed.
   * On mid-batch failure returns partial successes if any image was produced.
   */
  async imageRequest(account: Account, opts: GrokCliImageRequestOpts): Promise<GrokCliImageResult> {
    const prompt = (opts.prompt || "").trim();
    if (!prompt) return { success: false, error: "prompt is required" };
    const images = (opts.images || []).filter(Boolean).slice(0, 3);
    const n = Math.min(4, Math.max(1, Number(opts.n) || 1));

    const all: string[] = [];
    let usageSum: GrokCliUsageNormalized = emptyGrokCliUsage();
    let lastTokens: unknown;
    let working = account;

    for (let i = 0; i < n; i++) {
      const one = await this.runImageOnce(working, {
        prompt,
        images: images.length ? images : undefined,
        model: opts.model,
      });
      if (one.tokens) {
        lastTokens = one.tokens;
        working = { ...working, tokens: one.tokens } as Account;
      }
      if (!one.success || !one.imagesB64?.length) {
        if (all.length > 0) break;
        return one;
      }
      all.push(...one.imagesB64);
      if (one.usage) usageSum = addGrokCliUsage(usageSum, one.usage);
    }

    return {
      success: true,
      imagesB64: all,
      usage: usageSum,
      ...(lastTokens !== undefined ? { tokens: lastTokens } : {}),
    };
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

  private parsePersistedTokens(tokensJson?: string): unknown | undefined {
    if (!tokensJson) return undefined;
    try {
      return JSON.parse(tokensJson);
    } catch {
      return undefined;
    }
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const nonStreamReq = { ...request, stream: false };
    let working = account;
    let persistedTokens: string | undefined;

    const session = await this.requireFreshSession(working);
    if (!session.ok) {
      return this.failChat(session.error, { deadAccount: session.deadAccount });
    }
    working = session.account;
    persistedTokens = session.tokensJson;

    let { response } = await this.upstreamChat(working, nonStreamReq);

    if (response.status === 401) {
      const peek = await response.clone().text().catch(() => "");
      const auth = await this.handleAuthFailure(working, 401, peek);
      if (auth.kind === "dead") {
        return this.failChat(auth.error, { deadAccount: true });
      }
      if (auth.kind === "auth_failed") {
        return this.failChat(auth.error, { deadAccount: auth.deadAccount });
      }
      persistedTokens = auth.tokensJson;
      working = auth.account;
      ({ response } = await this.upstreamChat(working, nonStreamReq));
    }

    const text = await response.text();
    const kind = classifyGrokCliError(response.status, text);
    const parsedTokens = this.parsePersistedTokens(persistedTokens);
    if (!response.ok) {
      return this.failChat(
        kind === "exhausted"
          ? GROK_CLI_CREDIT_SOFT_ERROR
          : `Grok CLI HTTP ${response.status}: ${text.slice(0, 300)}`,
        {
          quotaExhausted: kind === "exhausted",
          deadAccount: kind === "dead",
          tokens: parsedTokens,
        }
      );
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return { success: false, error: "Invalid JSON from Grok CLI upstream" };
    }

    const usage = data.usage || {};
    const promptTokens = Number(usage.prompt_tokens) || 0;
    const completionTokens = Number(usage.completion_tokens) || 0;
    const total =
      Number(usage.total_tokens) ||
      promptTokens + completionTokens ||
      this.estimateMessagesTokens(request.messages);

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
      creditsUsed: total,
      creditSource: "estimated",
      ...(parsedTokens !== undefined ? { tokens: parsedTokens } : {}),
    };
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const streamReq = { ...request, stream: true };
    let working = account;
    let persistedTokens: string | undefined;

    const session = await this.requireFreshSession(working);
    if (!session.ok) {
      return this.failChat(session.error, { deadAccount: session.deadAccount });
    }
    working = session.account;
    persistedTokens = session.tokensJson;

    let { response } = await this.upstreamChat(working, streamReq);

    if (response.status === 401) {
      const peek = await response.clone().text().catch(() => "");
      const auth = await this.handleAuthFailure(working, 401, peek);
      if (auth.kind === "dead") {
        return this.failChat(auth.error, { deadAccount: true });
      }
      if (auth.kind === "auth_failed") {
        return this.failChat(auth.error, { deadAccount: auth.deadAccount });
      }
      persistedTokens = auth.tokensJson;
      working = auth.account;
      ({ response } = await this.upstreamChat(working, streamReq));
    }

    const parsedTokens = this.parsePersistedTokens(persistedTokens);
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      const kind = classifyGrokCliError(response.status, text);
      return this.failChat(
        kind === "exhausted"
          ? GROK_CLI_CREDIT_SOFT_ERROR
          : `Grok CLI stream HTTP ${response.status}: ${text.slice(0, 300)}`,
        {
          quotaExhausted: kind === "exhausted",
          deadAccount: kind === "dead",
          tokens: parsedTokens,
        }
      );
    }

    return {
      success: true,
      stream: response.body,
      promptTokens: 0,
      completionTokens: 0,
      tokensUsed: 0,
      ...(parsedTokens !== undefined ? { tokens: parsedTokens } : {}),
    };
  }

  async refreshToken(account: Account): Promise<RefreshResult> {
    const existing = this.refreshLocks.get(account.id);
    if (existing) return existing;

    const p = this.doRefreshToken(account).finally(() => {
      this.refreshLocks.delete(account.id);
    });
    this.refreshLocks.set(account.id, p);
    return p;
  }

  private async doRefreshToken(account: Account): Promise<RefreshResult> {
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
          error:
            kind === "dead"
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
        } catch {
          /* keep old */
        }
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

  /**
   * Shared OAuth prove for health (if-needed) and force refresh UI/API.
   */
  async proveSession(account: Account, mode: ProveMode): Promise<SessionProveResult> {
    if (isPermanentRevocation(account.errorMessage)) {
      return {
        ok: false,
        kind: "session_revoked",
        error: account.errorMessage || formatGrokCliDeadError("refresh token revoked"),
        refreshed: false,
        healthKind: "session_expired",
      };
    }

    const tokens = this.getTokens(account);
    if (!tokens?.access_token || !tokens?.refresh_token) {
      return {
        ok: false,
        kind: "missing_tokens",
        error: "No access_token/refresh_token for grok-cli account",
        refreshed: false,
        healthKind: "missing_tokens",
      };
    }

    const shouldRefresh =
      mode === "force-refresh" ||
      grokCliNeedsProactiveRefresh(tokens) ||
      account.status === "error" ||
      account.status === "pending";

    if (!shouldRefresh) {
      return {
        ok: true,
        kind: "healthy",
        refreshed: false,
        healthKind: "healthy",
        message: "Access token within refresh lead window",
      };
    }

    const refreshed = await this.refreshToken(account);
    if (!refreshed.success || !refreshed.tokens) {
      const formatted = formatGrokAuthFailure(refreshed.error || "refresh failed");
      // permanent → session_revoked (WarmUp latch); missing stays missing_tokens.
      if (formatted.kind === "permanent") {
        return {
          ok: false,
          kind: "session_revoked",
          error: formatted.error,
          refreshed: false,
          healthKind: "session_expired",
        };
      }
      if (formatted.kind === "missing") {
        return {
          ok: false,
          kind: "missing_tokens",
          error: formatted.error,
          refreshed: false,
          healthKind: "missing_tokens",
        };
      }
      return {
        ok: false,
        kind: "auth_error",
        error: formatted.error,
        refreshed: false,
        healthKind: "auth_error",
      };
    }

    let parsed: unknown = refreshed.tokens;
    try {
      parsed = JSON.parse(refreshed.tokens);
    } catch {
      /* keep string */
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

  /**
   * OAuth-aware health via proveSession(if-needed) + center credit probe.
   * Never reports healthy for invalid_grant (permanent revocation).
   * 402 spending-limit / free-usage death → kind exhausted (warmup zeros quota).
   */
  override async healthCheck(account: Account): Promise<
    import("./base").ProviderHealthResult
  > {
    const proved = await this.proveSession(account, "if-needed");
    if (!proved.ok) {
      if (proved.kind === "session_revoked") {
        return {
          kind: "session_expired",
          success: false,
          retryable: false,
          error: proved.error,
          metadata: { permanentRevocation: true },
        };
      }
      if (proved.kind === "missing_tokens") {
        return {
          kind: "missing_tokens",
          success: false,
          retryable: false,
          error: proved.error,
        };
      }
      return {
        kind: "auth_error",
        success: false,
        retryable: true,
        error: proved.error,
      };
    }

    // Session OK — probe center credit so UI/pool don't lie about 2M local remaining.
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
              source: q.source || "grok-cli.fetchQuota",
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
            source: q.source || "grok-cli.fetchQuota",
          }
        : undefined,
    };
  }

  /**
   * Prefer center signals (tiny chat probe → rate-limit headers / 402 body).
   * Fallback to local quota* columns only with source local-estimated (never claim upstream).
   */
  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: {
      limit: number;
      remaining: number;
      used: number;
      resetAt?: Date | string | null;
      source?: string;
    };
    exhausted?: boolean;
    error?: string;
  }> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) {
      return { success: false, error: "No access_token" };
    }

    // Tiny non-stream probe — same path as live traffic; center returns
    // x-ratelimit-* on OK or 402 spending-limit / 429 free-usage body.
    // Probe model MUST be a real catalog upstream (grok-4.5). Using a model
    // the center doesn't entitlement (e.g. "grok-4") returns 402 for every
    // account and mass-exhausts the pool on WarmUp.
    const PROBE_MODEL = resolveGrokCliUpstreamModel("grok-4.5");
    try {
      const response = await this.fetchWithTimeout(
        `${GROK_CLI_UPSTREAM_BASE}/chat/completions`,
        {
          method: "POST",
          headers: buildGrokCliHeaders(
            { ...tokens, email: account.email || tokens.email },
            PROBE_MODEL
          ),
          body: JSON.stringify({
            model: PROBE_MODEL,
            messages: [{ role: "user", content: "1" }],
            max_tokens: 1,
            stream: false,
          }),
        },
        config.providerQuotaTimeoutMs
      );

      const bodyText = await response.text().catch(() => "");
      const center = quotaFromGrokCliCenterSignals({
        headers: response.headers,
        body: bodyText,
        status: response.status,
      });

      if (center) {
        return {
          success: true,
          exhausted: center.exhausted,
          error: center.exhausted ? GROK_CLI_CREDIT_SOFT_ERROR : undefined,
          quota: {
            limit: center.limit,
            remaining: center.remaining,
            used: center.used,
            resetAt: center.resetAt,
            source: center.source,
          },
        };
      }

      // Unexpected non-OK without classifiable credit death — don't invent full local.
      if (!response.ok) {
        return {
          success: false,
          error: `Grok CLI quota probe HTTP ${response.status}`,
        };
      }
    } catch (e) {
      // Network blip — fall through to local estimate, labeled honestly.
      const msg = e instanceof Error ? e.message : String(e);
      return {
        success: true,
        ...this.localEstimatedQuota(account),
        error: `quota probe failed: ${msg.slice(0, 120)}`,
      };
    }

    return { success: true, ...this.localEstimatedQuota(account) };
  }

  private localEstimatedQuota(account: Account): {
    quota: {
      limit: number;
      remaining: number;
      used: number;
      resetAt: null;
      source: "local-estimated";
    };
  } {
    const limit =
      Number(account.quotaLimit) > 0 ? Number(account.quotaLimit) : GROK_CLI_TOKEN_LIMIT;
    const remainingRaw = account.quotaRemaining;
    const remaining = typeof remainingRaw === "number" ? remainingRaw : limit;
    const used = Math.max(0, limit - remaining);
    return {
      quota: {
        limit,
        remaining: Math.max(0, remaining),
        used,
        resetAt: null,
        source: "local-estimated",
      },
    };
  }
}

export const grokCliProvider = new GrokCliProvider();

