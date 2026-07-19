/** Catalog + model-id mapping for grok-cli. */

export type GrokCliEffort = "low" | "medium" | "high" | null;

/** Catalog IDs exposed on /v1/models (9router-style gcli/* effort aliases). */
export const GROK_CLI_CATALOG_IDS = [
  "gcli/grok-4.5",
  "gcli/grok-4.5-high",
  "gcli/grok-4.5-medium",
  "gcli/grok-4.5-low",
] as const;

/**
 * Map client model id → upstream model + optional reasoning effort.
 * All gcli/grok-4.5* aliases hit the same xAI model; effort suffixes only set reasoning_effort.
 */
export function parseGrokCliModelId(model: string): {
  upstream: string;
  effort: GrokCliEffort;
  bare: string;
} {
  let m = model.trim();
  const lower = m.toLowerCase();
  if (lower.startsWith("gcli/")) m = m.slice("gcli/".length);
  else if (lower.startsWith("grok-cli/")) m = m.slice("grok-cli/".length);
  else if (lower.startsWith("grok-cli-")) m = m.slice("grok-cli-".length);

  const bareLower = m.toLowerCase();
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

  const upstream = "grok-4.5";
  return { upstream, effort, bare: bare || upstream };
}

export function resolveGrokCliUpstreamModel(model: string): string {
  return parseGrokCliModelId(model).upstream;
}

export function grokCliOwnsModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (
    m === "gcli/grok-4.5" ||
    m === "gcli/grok-4.5-high" ||
    m === "gcli/grok-4.5-medium" ||
    m === "gcli/grok-4.5-low"
  ) {
    return true;
  }
  if (m === "gcli/grok-image" || m === "grok-image") return true;
  if (m.startsWith("gcli/")) {
    const rest = m.slice("gcli/".length);
    return (
      rest === "grok-4.5" ||
      rest.startsWith("grok-4.5-") ||
      rest === "grok-build" ||
      rest.startsWith("grok-4") ||
      rest === "grok-image"
    );
  }
  if (m === "grok-4.5" || m.startsWith("grok-4.5-") || m.startsWith("grok-4")) return true;
  if (m.startsWith("grok-cli/") || m.startsWith("grok-cli-")) {
    const rest = m.startsWith("grok-cli/")
      ? m.slice("grok-cli/".length)
      : m.slice("grok-cli-".length);
    return rest === "grok-4.5" || rest.startsWith("grok-4.5-") || rest.startsWith("grok-");
  }
  return false;
}
