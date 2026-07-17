import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";

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
  if (m.startsWith("gcli/")) {
    const rest = m.slice("gcli/".length);
    return rest === "grok-4.5" || rest.startsWith("grok-4.5-") || rest === "grok-build" || rest.startsWith("grok-4");
  }
  // bare + legacy prefixes (compat with early etteum clients)
  if (m === "grok-4.5" || m.startsWith("grok-4.5-") || m.startsWith("grok-4")) return true;
  if (m.startsWith("grok-cli/") || m.startsWith("grok-cli-")) {
    const rest = m.startsWith("grok-cli/") ? m.slice("grok-cli/".length) : m.slice("grok-cli-".length);
    return rest === "grok-4.5" || rest.startsWith("grok-4.5-") || rest.startsWith("grok-");
  }
  return false;
}

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

/** Parse expires_at from unix sec/ms or ISO-8601 string. */
export function parseGrokCliExpiresAt(raw: string | number | undefined | null): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw > 1e12 ? Math.floor(raw / 1000) : raw;
  }
  const s = String(raw).trim();
  if (!s) return null;
  const asNum = Number(s);
  if (Number.isFinite(asNum) && asNum > 0) {
    return asNum > 1e12 ? Math.floor(asNum / 1000) : asNum;
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

/** True if access token should be refreshed before calling upstream. */
export function grokCliNeedsProactiveRefresh(
  tokens: GrokCliTokens,
  leadSec = GROK_CLI_REFRESH_LEAD_SEC,
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

  private refreshLocks = new Map<number, Promise<RefreshResult>>();

  supportedModels: ModelInfo[] = GROK_CLI_CATALOG_IDS.map((id) => ({
    id,
    object: "model" as const,
    created: Date.now(),
    owned_by: "grok-cli",
    context_window: 256000,
    max_output: 16000,
    thinking: id !== "gcli/grok-4.5",
    creditUnit: "token" as const,
    creditRate: 1,
    creditSource: "estimated" as const,
  }));

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
      return { account, error: "No access_token for grok-cli account", dead: true };
    }
    if (!grokCliNeedsProactiveRefresh(tokens)) return { account };

    const refreshed = await this.refreshToken(account);
    if (!refreshed.success || !refreshed.tokens) {
      const dead = /invalid_grant|revoked|unknown refresh/i.test(refreshed.error || "");
      return { account, error: refreshed.error || "refresh failed", dead };
    }
    return {
      account: { ...account, tokens: JSON.parse(refreshed.tokens) } as Account,
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

    const fresh = await this.ensureFreshTokens(working);
    if (fresh.error && !this.getTokens(working)?.access_token) {
      return { success: false, error: fresh.error };
    }
    if (fresh.tokensJson) {
      working = fresh.account;
      persistedTokens = fresh.tokensJson;
    }

    let { response } = await this.upstreamChat(working, nonStreamReq);

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
    const parsedTokens = this.parsePersistedTokens(persistedTokens);
    if (!response.ok) {
      return {
        success: false,
        error: `Grok CLI HTTP ${response.status}: ${text.slice(0, 300)}`,
        quotaExhausted: kind === "exhausted",
        ...(parsedTokens !== undefined ? { tokens: parsedTokens } : {}),
      };
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

    const fresh = await this.ensureFreshTokens(working);
    if (fresh.tokensJson) {
      working = fresh.account;
      persistedTokens = fresh.tokensJson;
    }
    if (fresh.error && !this.getTokens(working)?.access_token) {
      return { success: false, error: fresh.error };
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

    const parsedTokens = this.parsePersistedTokens(persistedTokens);
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      const kind = classifyGrokCliError(response.status, text);
      return {
        success: false,
        error: `Grok CLI stream HTTP ${response.status}: ${text.slice(0, 300)}`,
        quotaExhausted: kind === "exhausted",
        ...(parsedTokens !== undefined ? { tokens: parsedTokens } : {}),
      };
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

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
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

