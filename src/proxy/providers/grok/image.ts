/**
 * Pure helpers for Grok free image generate/edit
 * (Responses API + image_generation tool — not paid api.x.ai).
 */

/** Strip optional `data:*;base64,` prefix from a data-URL or return as-is. */
export function stripGrokDataUrlPrefix(value: string): string {
  const s = value.trim();
  const m = /^data:[^;]+;base64,(.+)$/i.exec(s);
  return m?.[1] ? m[1].replace(/\s+/g, "") : s.replace(/\s+/g, "");
}

/**
 * Normalize one image ref into an upstream `image_url` string
 * (data-URL preferred; bare https left as-is).
 */
export function normalizeGrokImageRef(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input === "string") {
    const s = input.trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    if (/^data:/i.test(s)) return s;
    return `data:image/png;base64,${stripGrokDataUrlPrefix(s)}`;
  }
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const nested =
      obj.url ?? obj.image_url ?? obj.b64_json ?? obj.base64 ?? obj.data ?? obj.image;
    if (nested != null && nested !== input) return normalizeGrokImageRef(nested);
  }
  return null;
}

/** Collect image refs from OpenAI-ish image API body fields. Cap default 3. */
export function collectGrokImageRefs(
  body: { image?: unknown; images?: unknown; image_url?: unknown },
  max = 3
): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (out.length >= max) return;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (out.length >= max) break;
        const n = normalizeGrokImageRef(item);
        if (n) out.push(n);
      }
      return;
    }
    const n = normalizeGrokImageRef(v);
    if (n) out.push(n);
  };
  push(body.images);
  push(body.image);
  push(body.image_url);
  return out;
}

/**
 * Pull base64 images from a Responses API payload
 * (`output[].type === "image_generation_call"`).
 */
export function extractGrokImageGenerationResults(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const nestedOutput = (root as { response?: { output?: unknown } }).response?.output;
  const output = Array.isArray(root.output)
    ? root.output
    : Array.isArray(nestedOutput)
      ? nestedOutput
      : [];

  const images: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const type = String(row.type || "");
    if (type !== "image_generation_call" && type !== "image_generation") continue;

    const raw =
      row.result ??
      row.image ??
      row.content ??
      (typeof row.b64_json === "string" ? row.b64_json : null);

    if (typeof raw === "string" && raw.trim()) {
      images.push(stripGrokDataUrlPrefix(raw));
      continue;
    }
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      const nested = obj.b64_json ?? obj.base64 ?? obj.data ?? obj.result;
      if (typeof nested === "string" && nested.trim()) {
        images.push(stripGrokDataUrlPrefix(nested));
      }
    }
  }
  return images;
}

export type GrokUsageNormalized = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
};

export function normalizeGrokUsage(usage: unknown): GrokUsageNormalized {
  const u = (usage && typeof usage === "object" ? usage : {}) as Record<string, unknown>;
  const input = Number(u.input_tokens ?? u.prompt_tokens) || 0;
  const output = Number(u.output_tokens ?? u.completion_tokens) || 0;
  const total = Number(u.total_tokens) || input + output;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: total,
    input_tokens: input,
    output_tokens: output,
  };
}

export function emptyGrokUsage(): GrokUsageNormalized {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
  };
}

export function addGrokUsage(
  a: GrokUsageNormalized,
  b: GrokUsageNormalized
): GrokUsageNormalized {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  };
}

export type GrokImageResult = {
  success: boolean;
  imagesB64?: string[];
  usage?: GrokUsageNormalized;
  error?: string;
  quotaExhausted?: boolean;
  /** Permanent session death — pool should markError. */
  deadAccount?: boolean;
  tokens?: unknown;
};

export type GrokImageRequestOpts = {
  prompt: string;
  /** When non-empty → edit mode; when omitted/empty → generate. */
  images?: string[];
  n?: number;
  model?: string;
};

// deprecated aliases
export const stripGrokCliDataUrlPrefix = stripGrokDataUrlPrefix;
export const normalizeGrokCliImageRef = normalizeGrokImageRef;
export const collectGrokCliImageRefs = collectGrokImageRefs;
export const extractGrokCliImageGenerationResults = extractGrokImageGenerationResults;
export type GrokCliUsageNormalized = GrokUsageNormalized;
export const normalizeGrokCliUsage = normalizeGrokUsage;
export const emptyGrokCliUsage = emptyGrokUsage;
export const addGrokCliUsage = addGrokUsage;
export type GrokCliImageResult = GrokImageResult;
export type GrokCliImageRequestOpts = GrokImageRequestOpts;
