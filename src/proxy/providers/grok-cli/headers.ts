/**
 * Request headers for cli-chat-proxy — aligned with xai-org/grok-build SamplingClient.
 *
 * Auth (user OIDC token):
 *   Authorization: Bearer <access>
 *   X-XAI-Token-Auth: xai-grok-cli
 *
 * Fingerprint:
 *   x-grok-client-identifier: grok-shell (default)
 *   x-grok-client-version
 *   User-Agent: grok-shell/<ver> (os; arch)
 *
 * Session (GrokRequestHeaders):
 *   x-grok-conv-id, x-grok-req-id, x-grok-session-id,
 *   x-grok-agent-id, x-grok-model-override, optional x-grok-turn-idx
 */

import { randomUUID } from "node:crypto";
import {
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_CLIENT_VERSION,
  GROK_CLI_TOKEN_AUTH_VALUE,
} from "./constants";
import type { GrokCliTokens } from "./cpa";
import { resolveGrokCliUpstreamModel } from "./models";

export type GrokCliHeaderContext = {
  /** Stable across turns of one conversation when known. */
  sessionId?: string;
  convId?: string;
  reqId?: string;
  agentId?: string;
  turnIdx?: number;
  /** Official header x-grok-client-mode */
  clientMode?: "interactive" | "headless";
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

/** Official-style UA: `grok-shell/<ver> (os; arch)`. */
export function buildGrokCliUserAgent(clientVersion = GROK_CLI_CLIENT_VERSION): string {
  const ver = clientVersion || GROK_CLI_CLIENT_VERSION;
  const id = GROK_CLI_CLIENT_IDENTIFIER || "grok-shell";
  return `${id}/${ver} ${platformUaSuffix()}`;
}

export function buildGrokCliHeaders(
  tokens: Pick<
    GrokCliTokens,
    "access_token" | "email" | "team_id" | "sub" | "user_id" | "principal_id"
  > & { email?: string },
  model: string,
  clientVersion = GROK_CLI_CLIENT_VERSION,
  ctx: GrokCliHeaderContext = {}
): Record<string, string> {
  const ver = clientVersion || GROK_CLI_CLIENT_VERSION;
  const identifier = GROK_CLI_CLIENT_IDENTIFIER || "grok-shell";
  const upstreamModel = resolveGrokCliUpstreamModel(model);

  // Generate per-request ids when caller does not supply (full client always sends these).
  const reqId = ctx.reqId || randomUUID();
  const sessionId = ctx.sessionId || ctx.convId || randomUUID();
  const convId = ctx.convId || sessionId;
  const agentId = ctx.agentId || sessionId;

  // Bun/fetch Headers merges case-insensitive keys into a comma list.
  // Send a single token-auth key only (HTTP headers are case-insensitive).
  const h: Record<string, string> = {
    Authorization: `Bearer ${tokens.access_token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": buildGrokCliUserAgent(ver),
    "x-xai-token-auth": GROK_CLI_TOKEN_AUTH_VALUE,
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

  // Optional identity (official client may send x-grok-user-id; we keep email/userid compat).
  if (tokens.email) h["x-email"] = tokens.email;
  const uid = tokens.sub || tokens.user_id || tokens.principal_id;
  if (uid) {
    h["x-userid"] = String(uid);
    h["x-grok-user-id"] = String(uid);
  }
  if (tokens.team_id) h["x-teamid"] = String(tokens.team_id);

  return h;
}
