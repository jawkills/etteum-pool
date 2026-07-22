/**
 * Grok Build/CLI constants (no class, no I/O).
 *
 * Defaults aligned with open-source xAI Grok Build:
 * https://github.com/xai-org/grok-build
 *   - base: cli-chat-proxy.grok.com/v1
 *   - client identifier: grok-shell
 *   - user OAuth token-auth value: xai-grok-cli
 */

import { DEFAULT_GROK_REFRESH_LEAD_SEC } from "./settings";

/**
 * Quota limit is NEVER hardcoded.
 * Free-window truth comes only from cli-chat-proxy:
 *   - x-ratelimit-limit-tokens / x-ratelimit-remaining-tokens
 *   - body: tokens (actual/limit): N/M
 * Until center reports a limit, DB stays 0 (unknown).
 */

export const GROK_UPSTREAM_BASE =
  (
    process.env.GROK_UPSTREAM_BASE ||
    process.env.GROK_CLI_UPSTREAM_BASE ||
    "https://cli-chat-proxy.grok.com/v1"
  ).replace(/\/$/, "");

export const GROK_TOKEN_URL =
  process.env.GROK_TOKEN_URL ||
  process.env.GROK_CLI_TOKEN_URL ||
  "https://auth.x.ai/oauth2/token";

export const GROK_CLIENT_ID =
  process.env.GROK_CLIENT_ID ||
  process.env.GROK_CLI_CLIENT_ID ||
  "b1a00492-073a-47ea-816f-4c329264a828";

/** Matches xai-grok-sampler DEFAULT_CLIENT_IDENTIFIER / AGENT_PRODUCT. */
export const GROK_CLIENT_IDENTIFIER =
  process.env.GROK_CLIENT_IDENTIFIER ||
  process.env.GROK_CLI_CLIENT_IDENTIFIER ||
  "grok-shell";

/**
 * Client version stamped on x-grok-client-version + User-Agent.
 * Override when tracking a specific Grok Build release.
 */
export const GROK_CLIENT_VERSION =
  process.env.GROK_CLIENT_VERSION || process.env.GROK_CLI_CLIENT_VERSION || "0.2.99";

/** User-token auth marker required by cli-chat-proxy for OIDC tokens. */
export const GROK_TOKEN_AUTH_VALUE = "xai-grok-cli";

/** Default proactive-refresh lead (seconds). Runtime may override via settings. */
export const GROK_REFRESH_LEAD_SEC = DEFAULT_GROK_REFRESH_LEAD_SEC;

/** Image generate/edit via Responses API needs a longer budget than chat. */
export const GROK_IMAGE_TIMEOUT_MS =
  Number(process.env.GROK_IMAGE_TIMEOUT_MS || process.env.GROK_CLI_IMAGE_TIMEOUT_MS) || 180_000;

/** Soft client-facing string — do not dump multi-line center bodies for credit death. */
export const GROK_CREDIT_SOFT_ERROR = "Grok credits exhausted";
