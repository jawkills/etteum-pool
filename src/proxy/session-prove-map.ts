/**
 * Pure session-prove → ProviderHealthResult mapping.
 * Kept free of pool/registry imports so providers can use it without cycles.
 */

import type { ProviderHealthResult } from "./providers/base";

export type ProveMode = "if-needed" | "force-refresh";

export type SessionProveKind =
  | "healthy"
  | "session_revoked"
  | "missing_tokens"
  | "auth_error"
  | "unsupported";

export type SessionProveResult = {
  ok: boolean;
  kind: SessionProveKind;
  tokens?: unknown;
  error?: string;
  message?: string;
  refreshed: boolean;
  /** ProviderHealthKind-compatible mapping for warmup runner. */
  healthKind?: ProviderHealthResult["kind"];
};

/** Map prove result → ProviderHealthResult shape. */
export function sessionProveToHealth(result: SessionProveResult): ProviderHealthResult {
  if (result.ok) {
    return {
      kind: "healthy",
      success: true,
      tokens: result.tokens,
      message: result.message,
    };
  }
  switch (result.kind) {
    case "session_revoked":
      return {
        kind: "session_expired",
        success: false,
        retryable: false,
        error: result.error,
        metadata: { permanentRevocation: true },
      };
    case "missing_tokens":
      return {
        kind: "missing_tokens",
        success: false,
        retryable: false,
        error: result.error,
      };
    case "unsupported":
      return {
        kind: "unsupported",
        success: false,
        retryable: false,
        error: result.error,
      };
    default:
      return {
        kind: "auth_error",
        success: false,
        retryable: true,
        error: result.error,
      };
  }
}
