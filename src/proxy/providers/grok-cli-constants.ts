/** Shared Grok CLI env/constants (no class, no I/O). */

import { DEFAULT_GROK_CLI_REFRESH_LEAD_SEC } from "./grok-cli-settings";

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

/** Soft client-facing string — do not dump multi-line center bodies for credit death. */
export const GROK_CLI_CREDIT_SOFT_ERROR = "Grok CLI credits exhausted";
