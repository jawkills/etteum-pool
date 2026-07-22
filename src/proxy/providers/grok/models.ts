/**
 * Grok catalog (cli-chat-proxy / subscription).
 *
 * Public model IDs (no gcli/ prefix):
 *   grok-4.5 | grok-4.5-low | grok-4.5-medium | grok-4.5-high | grok-4.5-xhigh
 *
 * Upstream wire model is always `grok-4.5`.
 * Effort suffixes set reasoning_effort (xhigh; "max" accepted as alias → xhigh).
 */

export type GrokEffort = "low" | "medium" | "high" | "xhigh" | null;

/** Upstream model id on cli-chat-proxy. */
export const GROK_UPSTREAM_MODEL = "grok-4.5";

/** Public catalog — order matters for /v1/models listing. */
export const GROK_CATALOG_IDS = [
  "grok-4.5",
  "grok-4.5-low",
  "grok-4.5-medium",
  "grok-4.5-high",
  "grok-4.5-xhigh",
] as const;

export type GrokParsedModel = {
  upstream: string;
  effort: GrokEffort;
  /** true when effort came from model id suffix (overrides body). */
  effortFromModelId: boolean;
};

function normalizeEffortToken(raw: string): GrokEffort {
  const s = raw.toLowerCase();
  if (s === "low") return "low";
  if (s === "medium") return "medium";
  if (s === "high") return "high";
  if (s === "xhigh" || s === "max") return "xhigh";
  return null;
}

export function parseGrokModelId(model: string): GrokParsedModel {
  const m = model.trim().toLowerCase();
  if (!m) {
    return { upstream: GROK_UPSTREAM_MODEL, effort: null, effortFromModelId: false };
  }

  if (m === "grok-image") {
    return { upstream: GROK_UPSTREAM_MODEL, effort: null, effortFromModelId: false };
  }

  if (m === "grok-4.5") {
    return { upstream: GROK_UPSTREAM_MODEL, effort: null, effortFromModelId: false };
  }

  for (const suf of ["xhigh", "medium", "high", "low"] as const) {
    if (m === `grok-4.5-${suf}` || (suf === "xhigh" && m === "grok-4.5-max")) {
      return {
        upstream: GROK_UPSTREAM_MODEL,
        effort: suf,
        effortFromModelId: true,
      };
    }
  }

  if (m.startsWith("grok-4.5-")) {
    const effort = normalizeEffortToken(m.slice("grok-4.5-".length));
    if (effort) {
      return { upstream: GROK_UPSTREAM_MODEL, effort, effortFromModelId: true };
    }
  }

  return { upstream: GROK_UPSTREAM_MODEL, effort: null, effortFromModelId: false };
}

export function resolveGrokUpstreamModel(model: string): string {
  return parseGrokModelId(model).upstream;
}

export function grokOwnsModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;
  if (m === "grok-4.5" || m === "grok-image") return true;
  if (
    m === "grok-4.5-low" ||
    m === "grok-4.5-medium" ||
    m === "grok-4.5-high" ||
    m === "grok-4.5-xhigh" ||
    m === "grok-4.5-max"
  ) {
    return true;
  }
  return false;
}

// deprecated aliases
export const GROK_CLI_CATALOG_IDS = GROK_CATALOG_IDS;
export function parseGrokCliModelId(model: string) {
  const p = parseGrokModelId(model);
  return {
    upstream: p.upstream,
    effort: p.effort,
    bare: "grok-4.5",
    allowReasoningEffort: true,
    effortFromModelId: p.effortFromModelId,
  };
}
export function resolveGrokCliUpstreamModel(model: string): string {
  return resolveGrokUpstreamModel(model);
}
export function grokCliOwnsModel(model: string): boolean {
  return grokOwnsModel(model);
}
