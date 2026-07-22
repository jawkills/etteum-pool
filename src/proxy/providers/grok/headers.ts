/**
 * Request headers for cli-chat-proxy — aligned with xai-org/grok-build SamplingClient.
 * Session ids are stable when a seed (prompt_cache_key / hash) is provided.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  GROK_CLIENT_IDENTIFIER,
  GROK_CLIENT_VERSION,
  GROK_TOKEN_AUTH_VALUE,
} from "./constants";
import type { GrokTokens } from "./auth";
import { resolveGrokUpstreamModel } from "./models";

export type GrokHeaderContext = {
  sessionId?: string;
  convId?: string;
  reqId?: string;
  agentId?: string;
  turnIdx?: number;
  clientMode?: "interactive" | "headless";
  /** Deterministic seed for session/conv (e.g. prompt_cache_key). */
  sessionSeed?: string;
};

function platformUaSuffix(): string {
  const os =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "macos"
        : "linux";
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `(${os}; ${arch})`;
}

export function buildGrokUserAgent(clientVersion = GROK_CLIENT_VERSION): string {
  const ver = clientVersion || GROK_CLIENT_VERSION;
  const id = GROK_CLIENT_IDENTIFIER || "grok-shell";
  return `${id}/${ver} ${platformUaSuffix()}`;
}

/** Derive a stable UUID-like id from a seed string. */
export function stableSessionIdFromSeed(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  // Format as UUID v4-ish for header friendliness
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16),
    ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0") +
      hex.slice(18, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function buildGrokHeaders(
  tokens: Pick<
    GrokTokens,
    "access_token" | "email" | "team_id" | "sub" | "user_id" | "principal_id"
  > & { email?: string },
  model: string,
  clientVersion = GROK_CLIENT_VERSION,
  ctx: GrokHeaderContext = {}
): Record<string, string> {
  const ver = clientVersion || GROK_CLIENT_VERSION;
  const identifier = GROK_CLIENT_IDENTIFIER || "grok-shell";
  const upstreamModel = resolveGrokUpstreamModel(model);

  const reqId = ctx.reqId || randomUUID();
  const seeded =
    ctx.sessionId ||
    ctx.convId ||
    (ctx.sessionSeed ? stableSessionIdFromSeed(ctx.sessionSeed) : randomUUID());
  const sessionId = seeded;
  const convId = ctx.convId || sessionId;
  const agentId = ctx.agentId || sessionId;

  const h: Record<string, string> = {
    Authorization: `Bearer ${tokens.access_token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": buildGrokUserAgent(ver),
    "x-xai-token-auth": GROK_TOKEN_AUTH_VALUE,
    "x-grok-client-identifier": identifier,
    "x-grok-client-version": ver,
    "x-grok-client-mode": ctx.clientMode || "interactive",
    "x-grok-model-override": upstreamModel,
    "x-grok-req-id": reqId,
    "x-grok-session-id": sessionId,
    "x-grok-conv-id": convId,
    "x-grok-agent-id": agentId,
  };

  if (ctx.turnIdx != null && Number.isFinite(ctx.turnIdx)) {
    h["x-grok-turn-idx"] = String(Math.max(0, Math.floor(ctx.turnIdx)));
  }

  if (tokens.email) h["x-email"] = tokens.email;
  const uid = tokens.sub || tokens.user_id || tokens.principal_id;
  if (uid) {
    h["x-userid"] = String(uid);
    h["x-grok-user-id"] = String(uid);
  }
  if (tokens.team_id) h["x-teamid"] = String(tokens.team_id);

  return h;
}

/** @deprecated */
export const buildGrokCliUserAgent = buildGrokUserAgent;
/** @deprecated */
export const buildGrokCliHeaders = buildGrokHeaders;
