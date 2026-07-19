/**
 * Request headers for cli-chat-proxy — aligned with xai-org/grok-build SamplingClient.
 */

import { randomUUID } from "node:crypto";
import {
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_CLIENT_VERSION,
  GROK_CLI_TOKEN_AUTH_VALUE,
} from "./constants";
import type { GrokCliTokens } from "./cpa";
import { resolveGrokUpstreamModel } from "./models";

export type GrokHeaderContext = {
  sessionId?: string;
  convId?: string;
  reqId?: string;
  agentId?: string;
  turnIdx?: number;
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

export function buildGrokUserAgent(clientVersion = GROK_CLI_CLIENT_VERSION): string {
  const ver = clientVersion || GROK_CLI_CLIENT_VERSION;
  const id = GROK_CLI_CLIENT_IDENTIFIER || "grok-shell";
  return `${id}/${ver} ${platformUaSuffix()}`;
}

export const buildGrokCliUserAgent = buildGrokUserAgent;

export function buildGrokHeaders(
  tokens: Pick<
    GrokCliTokens,
    "access_token" | "email" | "team_id" | "sub" | "user_id" | "principal_id"
  > & { email?: string },
  model: string,
  clientVersion = GROK_CLI_CLIENT_VERSION,
  ctx: GrokHeaderContext = {}
): Record<string, string> {
  const ver = clientVersion || GROK_CLI_CLIENT_VERSION;
  const identifier = GROK_CLI_CLIENT_IDENTIFIER || "grok-shell";
  const upstreamModel = resolveGrokUpstreamModel(model);

  const reqId = ctx.reqId || randomUUID();
  const sessionId = ctx.sessionId || ctx.convId || randomUUID();
  const convId = ctx.convId || sessionId;
  const agentId = ctx.agentId || sessionId;

  const h: Record<string, string> = {
    Authorization: `Bearer ${tokens.access_token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": buildGrokUserAgent(ver),
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

  if (tokens.email) h["x-email"] = tokens.email;
  const uid = tokens.sub || tokens.user_id || tokens.principal_id;
  if (uid) {
    h["x-userid"] = String(uid);
    h["x-grok-user-id"] = String(uid);
  }
  if (tokens.team_id) h["x-teamid"] = String(tokens.team_id);

  return h;
}

export const buildGrokCliHeaders = buildGrokHeaders;
