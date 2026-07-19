/** CPA / token shape normalize for grok-cli import + refresh. */

import { GROK_CLI_CLIENT_ID } from "./constants";

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
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString(
      "utf8"
    );
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
      "access_token",
      "refresh_token",
      "id_token",
      "token_type",
      "accessToken",
      "refreshToken",
      "idToken",
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
