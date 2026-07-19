/**
 * Shared HTTP status mapping + OpenAI image envelope helpers.
 * Used by /v1/images/* and Image Studio Grok path.
 */

export function imageFailureStatus(msg: string): 429 | 502 | 503 {
  if (/no active|no.*account/i.test(msg)) return 503;
  if (/quota|exhaust|rate.?limit|429/i.test(msg)) return 429;
  return 502;
}

export function openAIImagesResponse(
  imagesB64: string[],
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  }
) {
  return {
    created: Math.floor(Date.now() / 1000),
    data: imagesB64.map((b64_json) => ({ b64_json })),
    usage: usage
      ? {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
        }
      : undefined,
  };
}

/** Free Grok CLI images do not consume local pool quota counters. */
export const GROK_CLI_IMAGE_DECREMENT_QUOTA = false;
