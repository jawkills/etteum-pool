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
