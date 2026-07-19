/**
 * Catalog + model-id mapping for grok-cli (cli-chat-proxy).
 *
 * Official Grok Build default model name is `grok-build` (see xai-org/grok-build docs).
 * We also expose gcli/grok-4.5* effort aliases (pool/9router-style).
 *
 * Default inference path remains Chat Completions (ApiBackend::ChatCompletions in grok-build).
 * Responses is used only for capability paths (e.g. image_generation tool).
 */

export type GrokCliEffort = "low" | "medium" | "high" | null;

/** Upstream model id used when client omits / sends bare gcli default. */
export const GROK_CLI_DEFAULT_UPSTREAM_MODEL = "grok-build";

/** Catalog IDs exposed on /v1/models. */
export const GROK_CLI_CATALOG_IDS = [
  "gcli/grok-build",
  "gcli/grok-4.5",
  "gcli/grok-4.5-high",
  "gcli/grok-4.5-medium",
  "gcli/grok-4.5-low",
] as const;

export type GrokCliParsedModel = {
  /** Model id sent to cli-chat-proxy */
  upstream: string;
  /** reasoning_effort for Completions (only grok-4.5 family) */
  effort: GrokCliEffort;
  /** Bare id without gcli/ prefix / effort suffix */
  bare: string;
  /** When false, do not attach reasoning_effort (grok-build rejects it) */
  allowReasoningEffort: boolean;
};

function stripClientPrefix(model: string): string {
  let m = model.trim();
  const lower = m.toLowerCase();
  if (lower.startsWith("gcli/")) m = m.slice("gcli/".length);
  else if (lower.startsWith("grok-cli/")) m = m.slice("grok-cli/".length);
  else if (lower.startsWith("grok-cli-")) m = m.slice("grok-cli-".length);
  return m;
}

/**
 * Map client model id → upstream model + optional reasoning effort.
 *
 * - gcli/grok-build | grok-build → upstream grok-build, no effort
 * - gcli/grok-4.5[-high|medium|low] → upstream grok-4.5 + effort
 * - bare grok-4.5* same
 * - unknown bare under gcli/ still owned but upstream as bare (or grok-build fallback)
 */
export function parseGrokCliModelId(model: string): GrokCliParsedModel {
  const original = model.trim();
  if (!original) {
    return {
      upstream: GROK_CLI_DEFAULT_UPSTREAM_MODEL,
      effort: null,
      bare: GROK_CLI_DEFAULT_UPSTREAM_MODEL,
      allowReasoningEffort: false,
    };
  }

  let m = stripClientPrefix(original);
  const bareLower = m.toLowerCase();

  // Effort suffixes only apply to grok-4.5 family (not grok-build).
  let effort: GrokCliEffort = null;
  let bare = m;
  if (bareLower.endsWith("-high")) {
    effort = "high";
    bare = m.slice(0, -"-high".length);
  } else if (bareLower.endsWith("-medium")) {
    effort = "medium";
    bare = m.slice(0, -"-medium".length);
  } else if (bareLower.endsWith("-low")) {
    effort = "low";
    bare = m.slice(0, -"-low".length);
  }

  const bareNorm = bare.toLowerCase() || GROK_CLI_DEFAULT_UPSTREAM_MODEL;

  // Product default / TUI model
  if (bareNorm === "grok-build" || bareNorm === "gb") {
    return {
      upstream: "grok-build",
      effort: null,
      bare: "grok-build",
      allowReasoningEffort: false,
    };
  }

  // Image path uses responses + image_generation; model still routed as 4.5 family upstream.
  if (bareNorm === "grok-image") {
    return {
      upstream: "grok-4.5",
      effort: null,
      bare: "grok-image",
      allowReasoningEffort: false,
    };
  }

  // grok-4.5 family (effort aliases)
  if (bareNorm === "grok-4.5" || bareNorm.startsWith("grok-4.5")) {
    return {
      upstream: "grok-4.5",
      effort,
      bare: "grok-4.5",
      allowReasoningEffort: true,
    };
  }

  // Legacy bare grok-4* → treat as 4.5 chat model
  if (bareNorm.startsWith("grok-4")) {
    return {
      upstream: "grok-4.5",
      effort,
      bare: bareNorm,
      allowReasoningEffort: true,
    };
  }

  // Fallback: pass through bare id (custom / future models)
  return {
    upstream: bare || GROK_CLI_DEFAULT_UPSTREAM_MODEL,
    effort: null,
    bare: bare || GROK_CLI_DEFAULT_UPSTREAM_MODEL,
    allowReasoningEffort: false,
  };
}

export function resolveGrokCliUpstreamModel(model: string): string {
  return parseGrokCliModelId(model).upstream;
}

export function grokCliOwnsModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;

  const catalog = new Set([
    "gcli/grok-build",
    "gcli/grok-4.5",
    "gcli/grok-4.5-high",
    "gcli/grok-4.5-medium",
    "gcli/grok-4.5-low",
    "gcli/grok-image",
    "grok-build",
    "grok-image",
    "grok-4.5",
    "gcli/grok-4.5",
  ]);
  if (catalog.has(m)) return true;

  if (m.startsWith("gcli/")) {
    const rest = m.slice("gcli/".length);
    return (
      rest === "grok-build" ||
      rest === "grok-4.5" ||
      rest.startsWith("grok-4.5-") ||
      rest.startsWith("grok-4") ||
      rest === "grok-image"
    );
  }
  if (m === "grok-4.5" || m.startsWith("grok-4.5-") || m.startsWith("grok-4")) return true;
  if (m.startsWith("grok-cli/") || m.startsWith("grok-cli-")) {
    const rest = m.startsWith("grok-cli/")
      ? m.slice("grok-cli/".length)
      : m.slice("grok-cli-".length);
    return (
      rest === "grok-build" ||
      rest === "grok-4.5" ||
      rest.startsWith("grok-4.5-") ||
      rest.startsWith("grok-")
    );
  }
  return false;
}
