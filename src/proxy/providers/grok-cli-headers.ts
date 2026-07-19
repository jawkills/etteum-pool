/** Request headers for cli-chat-proxy. */

import {
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_CLIENT_VERSION,
} from "./grok-cli-constants";
import type { GrokCliTokens } from "./grok-cli-cpa";
import { resolveGrokCliUpstreamModel } from "./grok-cli-models";

export function buildGrokCliHeaders(
  tokens: Pick<
    GrokCliTokens,
    "access_token" | "email" | "team_id" | "sub" | "user_id" | "principal_id"
  > & { email?: string },
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
