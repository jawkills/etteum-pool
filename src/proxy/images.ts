import { Hono } from "hono";
import type { Context } from "hono";
import { prepareLogBody } from "./logging";
import { recordRequest } from "./request-log";
import { collectGrokCliImageRefs } from "./providers/grok/image";
import { runGrokCliImagePool } from "./grok-image-pool";
import { imageFailureStatus, openAIImagesResponse } from "./image-response";

export const imagesRouter = new Hono();

type GrokImageBody = {
  model?: string;
  prompt?: string;
  n?: number;
  response_format?: string;
  image?: unknown;
  images?: unknown;
  image_url?: unknown;
};

function isJsonParseError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error && /json|parse|unexpected end|unexpected token/i.test(error.message))
  );
}

function invalidRequest(message: string) {
  return {
    error: {
      message,
      type: "invalid_request_error",
      code: "invalid_request",
    },
  };
}

async function handleImages(
  c: Context,
  opts: { requireImages: boolean; source: string }
) {
  let body: GrokImageBody;
  try {
    body = await c.req.json<GrokImageBody>();
  } catch (error) {
    if (isJsonParseError(error)) {
      return c.json(invalidRequest("Invalid JSON request body"), 400);
    }
    throw error;
  }

  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    return c.json(invalidRequest("prompt is required"), 400);
  }

  const images = collectGrokCliImageRefs(body);
  if (opts.requireImages && images.length === 0) {
    return c.json(invalidRequest("image is required"), 400);
  }

  // Generations with image payload is treated as edit (documented OpenAI-compat convenience).
  const mode = images.length > 0 ? "edit" : "generate";
  const n = Math.min(4, Math.max(1, Number(body.n) || 1));
  const model = String(body.model || "grok-image").trim() || "grok-image";

  const { result, accountId, accountEmail, durationMs } = await runGrokCliImagePool({
    mode,
    prompt,
    n,
    model,
    images,
  });

  void recordRequest({
    accountId: accountId ?? null,
    accountEmail: accountEmail ?? null,
    provider: "grok",
    model,
    promptTokens: result.usage?.prompt_tokens || 0,
    completionTokens: result.usage?.completion_tokens || 0,
    totalTokens: result.usage?.total_tokens || 0,
    // Free CLI path: log image count as creditsUsed for observability only.
    // Local pool quota is not decremented (see GROK_CLI_IMAGE_DECREMENT_QUOTA).
    creditsUsed: result.imagesB64?.length || 0,
    status: result.success ? "success" : "error",
    durationMs,
    errorMessage: result.success ? null : result.error || "image request failed",
    requestBody: prepareLogBody({
      model,
      prompt,
      n,
      mode,
      image_count: images.length,
      _poolprox: { source: opts.source },
    }),
    responseBody: prepareLogBody({
      image_count: result.imagesB64?.length || 0,
      usage: result.usage,
    }),
  });

  if (!result.success || !result.imagesB64?.length) {
    const msg = result.error || "Image request failed";
    const status = imageFailureStatus(msg);
    return c.json(
      {
        error: {
          message: msg,
          type: status === 429 ? "rate_limit_error" : "server_error",
          code: status === 429 ? "quota_exhausted" : "image_request_failed",
        },
      },
      status
    );
  }

  return c.json(openAIImagesResponse(result.imagesB64, result.usage));
}

/**
 * POST /v1/images/generations — OpenAI-compatible image generation.
 * Free Grok path uses Responses + image_generation tool (not api.x.ai).
 * If body includes image/images, routes to edit behavior.
 */
imagesRouter.post("/v1/images/generations", (c) =>
  handleImages(c, { requireImages: false, source: "v1.images.generations" })
);

/**
 * POST /v1/images/edits — OpenAI-compatible image edit via Grok free path.
 */
imagesRouter.post("/v1/images/edits", (c) =>
  handleImages(c, { requireImages: true, source: "v1.images.edits" })
);
