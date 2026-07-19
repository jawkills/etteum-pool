/** Shared Grok env/constants (no class, no I/O).
 *
 * Defaults aligned with open-source xAI Grok Build:
 * https://github.com/xai-org/grok-build
 *   - base: cli-chat-proxy.grok.com/v1
 *   - client identifier: grok-shell
 *   - user OAuth token-auth value: xai-grok-cli
 */

import { DEFAULT_GROK_CLI_REFRESH_LEAD_SEC } from "./settings";

export const GROK_CLI_TOKEN_LIMIT = 2_000_000;
export const GROK_CLI_UPSTREAM_BASE =
  process.env.GROK_CLI_UPSTREAM_BASE?.replace(/\/$/, "") ||
  "https://cli-chat-proxy.grok.com/v1";
export const GROK_CLI_TOKEN_URL =
  process.env.GROK_CLI_TOKEN_URL || "https://auth.x.ai/oauth2/token";
export const GROK_CLI_CLIENT_ID =
  process.env.GROK_CLI_CLIENT_ID || "b1a00492-073a-47ea-816f-4c329264a828";

/** Matches xai-grok-sampler DEFAULT_CLIENT_IDENTIFIER / AGENT_PRODUCT. */
export const GROK_CLI_CLIENT_IDENTIFIER =
  process.env.GROK_CLI_CLIENT_IDENTIFIER || "grok-shell";

/**
 * Client version stamped on x-grok-client-version + User-Agent.
 * Override when tracking a specific Grok Build release (env or settings later).
 */
export const GROK_CLI_CLIENT_VERSION =
  process.env.GROK_CLI_CLIENT_VERSION || "0.2.99";

/** User-token auth marker required by cli-chat-proxy for OIDC tokens. */
export const GROK_CLI_TOKEN_AUTH_VALUE = "xai-grok-cli";

/** Default proactive-refresh lead (seconds). Runtime may override via settings cache. */
export const GROK_CLI_REFRESH_LEAD_SEC = DEFAULT_GROK_CLI_REFRESH_LEAD_SEC;

/** Image generate/edit via Responses API needs a longer budget than chat. */
export const GROK_CLI_IMAGE_TIMEOUT_MS =
  Number(process.env.GROK_CLI_IMAGE_TIMEOUT_MS) || 180_000;

/** Soft client-facing string — do not dump multi-line center bodies for credit death. */
export const GROK_CLI_CREDIT_SOFT_ERROR = "Grok credits exhausted";
