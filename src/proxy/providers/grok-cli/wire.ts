/**
 * Upstream HTTP wire for Grok CLI (chat / image / refresh).
 * Free functions — provider class only owns session policy + locks.
 */

import type { Account } from "../../../db/schema";
import { config } from "../../../config";
import type { ChatCompletionRequest, ChatCompletionResponse, ProviderResult } from "../base";
import {
  GROK_CLI_CLIENT_ID,
  GROK_CLI_CREDIT_SOFT_ERROR,
  GROK_CLI_IMAGE_TIMEOUT_MS,
  GROK_CLI_TOKEN_LIMIT,
  GROK_CLI_TOKEN_URL,
  GROK_CLI_UPSTREAM_BASE,
} from "./constants";
import { type GrokCliTokens, normalizeGrokCliCpa } from "./cpa";
import {
  classifyGrokCliError,
  quotaFromGrokCliCenterSignals,
} from "./errors";
import {
  type GrokCliImageRequestOpts,
  type GrokCliImageResult,
  type GrokCliUsageNormalized,
  addGrokCliUsage,
  emptyGrokCliUsage,
  extractGrokCliImageGenerationResults,
  normalizeGrokCliUsage,
} from "./image";
import { normalizeGrokCliMessagesForOpenAI } from "./messages";
import { parseGrokCliModelId, resolveGrokCliUpstreamModel } from "./models";
import { buildGrokCliHeaders } from "./headers";

export type FetchWithTimeout = (
  url: string,
  init: RequestInit,
  timeoutMs: number
) => Promise<Response>;

export type UpstreamPipe = (
  account: Account,
  call: (working: Account) => Promise<Response>
) => Promise<
  | { ok: true; response: Response; account: Account; tokensJson?: string }
  | { ok: false; error: string; deadAccount: boolean; tokensJson?: string }
>;

export function readGrokCliTokens(account: Account): GrokCliTokens | null {
  try {
    const raw =
      typeof account.tokens === "string" ? JSON.parse(account.tokens as string) : account.tokens;
    if (!raw?.access_token) return null;
    return { ...raw, email: raw.email || account.email } as GrokCliTokens;
  } catch {
    return null;
  }
}

export function parsePersistedTokens(tokensJson?: string): unknown | undefined {
  if (!tokensJson) return undefined;
  try {
    return JSON.parse(tokensJson);
  } catch {
    return undefined;
  }
}

export function prepareGrokCliChatRequest(
  request: ChatCompletionRequest
): ChatCompletionRequest {
  let stripped = request;
  if (request.tools?.length) {
    const cleaned = request.tools.filter(
      (t: any) => !(t && typeof t === "object" && t.type === "custom")
    );
    if (cleaned.length !== request.tools.length) {
      stripped = { ...request, tools: cleaned };
    }
  }
  return {
    ...stripped,
    messages: normalizeGrokCliMessagesForOpenAI(
      stripped.messages
    ) as ChatCompletionRequest["messages"],
  };
}

export function failGrokCliChat(
  error: string,
  opts?: { deadAccount?: boolean; quotaExhausted?: boolean; tokens?: unknown }
): ProviderResult {
  return {
    success: false,
    error,
    deadAccount: opts?.deadAccount,
    quotaExhausted: opts?.quotaExhausted,
    ...(opts?.tokens !== undefined ? { tokens: opts.tokens } : {}),
  };
}

export function failGrokCliImage(
  error: string,
  opts?: { deadAccount?: boolean; quotaExhausted?: boolean; tokens?: unknown }
): GrokCliImageResult {
  return {
    success: false,
    error,
    deadAccount: opts?.deadAccount,
    quotaExhausted: opts?.quotaExhausted,
    ...(opts?.tokens !== undefined ? { tokens: opts.tokens } : {}),
  };
}

export async function grokCliUpstreamChat(
  fetchWithTimeout: FetchWithTimeout,
  account: Account,
  request: ChatCompletionRequest
): Promise<{ response: Response; tokens: GrokCliTokens }> {
  const tokens = readGrokCliTokens(account);
  if (!tokens?.access_token) throw new Error("No access_token for grok-cli account");

  const req = prepareGrokCliChatRequest(request);
  const parsed = parseGrokCliModelId(req.model);
  const model = parsed.upstream;
  const body: Record<string, unknown> = {
    ...req,
    model,
    stream: !!req.stream,
  };
  // Official grok-build rejects reasoningEffort; only attach for 4.5 family.
  if (
    parsed.allowReasoningEffort &&
    parsed.effort &&
    body.reasoning_effort == null &&
    (body as any).reasoningEffort == null
  ) {
    body.reasoning_effort = parsed.effort;
  }

  const response = await fetchWithTimeout(
    `${GROK_CLI_UPSTREAM_BASE}/chat/completions`,
    {
      method: "POST",
      headers: buildGrokCliHeaders({ ...tokens, email: account.email }, req.model || model),
      body: JSON.stringify(body),
    },
    config.providerRequestTimeoutMs
  );
  return { response, tokens };
}

export async function grokCliUpstreamImage(
  fetchWithTimeout: FetchWithTimeout,
  account: Account,
  opts: { prompt: string; images?: string[]; model?: string }
): Promise<{ response: Response; tokens: GrokCliTokens }> {
  const tokens = readGrokCliTokens(account);
  if (!tokens?.access_token) throw new Error("No access_token for grok-cli account");

  const model = resolveGrokCliUpstreamModel(opts.model || "gcli/grok-4.5");
  const content: Array<Record<string, string>> = [];
  for (const imageUrl of opts.images || []) {
    content.push({ type: "input_image", image_url: imageUrl });
  }
  const mode = (opts.images?.length || 0) > 0 ? "Edit" : "Generate";
  content.push({
    type: "input_text",
    text: `${mode} an image: ${opts.prompt}. Use the image_generation tool.`,
  });

  const body = {
    model,
    input: [{ role: "user", content }],
    tools: [{ type: "image_generation" }],
    stream: false,
    reasoning: { effort: "low" },
    max_output_tokens: 1024,
  };

  const response = await fetchWithTimeout(
    `${GROK_CLI_UPSTREAM_BASE}/responses`,
    {
      method: "POST",
      headers: buildGrokCliHeaders({ ...tokens, email: account.email }, model),
      body: JSON.stringify(body),
    },
    GROK_CLI_IMAGE_TIMEOUT_MS
  );
  return { response, tokens };
}

export async function grokCliDoRefresh(
  fetchWithTimeout: FetchWithTimeout,
  account: Account
): Promise<{ success: boolean; tokens?: string; error?: string }> {
  const tokens = readGrokCliTokens(account);
  if (!tokens?.refresh_token) return { success: false, error: "No refresh_token" };

  try {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: tokens.client_id || GROK_CLI_CLIENT_ID,
      refresh_token: tokens.refresh_token,
    });

    const response = await fetchWithTimeout(
      GROK_CLI_TOKEN_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "grok-cli/proxy",
        },
        body: form.toString(),
      },
      15000
    );

    const text = await response.text();
    if (!response.ok) {
      const kind = classifyGrokCliError(response.status, text);
      return {
        success: false,
        error:
          kind === "dead"
            ? `invalid_grant: ${text.slice(0, 200)}`
            : `Refresh failed (${kind || response.status}): ${text.slice(0, 200)}`,
      };
    }

    const data = JSON.parse(text);
    if (!data.access_token) return { success: false, error: "No access_token in refresh response" };

    const expiresIn = Number(data.expires_in) || 21600;
    const next: GrokCliTokens = {
      ...tokens,
      access_token: data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      id_token: data.id_token || tokens.id_token,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      email: tokens.email || account.email,
    };

    if (next.id_token) {
      try {
        const normalized = normalizeGrokCliCpa({
          email: next.email,
          access_token: next.access_token,
          refresh_token: next.refresh_token,
          id_token: next.id_token,
        });
        next.team_id = normalized.team_id || next.team_id;
        next.sub = normalized.sub || next.sub;
      } catch {
        /* keep old */
      }
    }

    return { success: true, tokens: JSON.stringify(next) };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function grokCliRunImageOnce(
  withUpstream: UpstreamPipe,
  account: Account,
  opts: { prompt: string; images?: string[]; model?: string },
  fetchWithTimeout: FetchWithTimeout
): Promise<GrokCliImageResult> {
  const pipe = await withUpstream(account, async (working) => {
    const { response } = await grokCliUpstreamImage(fetchWithTimeout, working, opts);
    return response;
  });
  if (!pipe.ok) {
    return failGrokCliImage(pipe.error, {
      deadAccount: pipe.deadAccount,
      tokens: parsePersistedTokens(pipe.tokensJson),
    });
  }

  const text = await pipe.response.text();
  const kind = classifyGrokCliError(pipe.response.status, text);
  const parsedTokens = parsePersistedTokens(pipe.tokensJson);
  if (!pipe.response.ok) {
    return failGrokCliImage(
      kind === "exhausted"
        ? GROK_CLI_CREDIT_SOFT_ERROR
        : `Grok CLI image HTTP ${pipe.response.status}: ${text.slice(0, 300)}`,
      {
        quotaExhausted: kind === "exhausted",
        deadAccount: kind === "dead",
        tokens: parsedTokens,
      }
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return failGrokCliImage("Invalid JSON from Grok CLI image upstream");
  }

  const imagesB64 = extractGrokCliImageGenerationResults(data);
  if (imagesB64.length === 0) {
    return failGrokCliImage("No image_generation_call result in upstream response", {
      tokens: parsedTokens,
    });
  }

  const usage = normalizeGrokCliUsage((data as any)?.usage);
  return {
    success: true,
    imagesB64,
    usage,
    ...(parsedTokens !== undefined ? { tokens: parsedTokens } : {}),
  };
}

export async function grokCliImageRequest(
  withUpstream: UpstreamPipe,
  account: Account,
  opts: GrokCliImageRequestOpts,
  fetchWithTimeout: FetchWithTimeout
): Promise<GrokCliImageResult> {
  const prompt = (opts.prompt || "").trim();
  if (!prompt) return { success: false, error: "prompt is required" };
  const images = (opts.images || []).filter(Boolean).slice(0, 3);
  const n = Math.min(4, Math.max(1, Number(opts.n) || 1));

  const all: string[] = [];
  let usageSum: GrokCliUsageNormalized = emptyGrokCliUsage();
  let lastTokens: unknown;
  let working = account;

  for (let i = 0; i < n; i++) {
    const one = await grokCliRunImageOnce(
      withUpstream,
      working,
      {
        prompt,
        images: images.length ? images : undefined,
        model: opts.model,
      },
      fetchWithTimeout
    );
    if (one.tokens) {
      lastTokens = one.tokens;
      working = { ...working, tokens: one.tokens } as Account;
    }
    if (!one.success || !one.imagesB64?.length) {
      if (all.length > 0) break;
      return one;
    }
    all.push(...one.imagesB64);
    if (one.usage) usageSum = addGrokCliUsage(usageSum, one.usage);
  }

  return {
    success: true,
    imagesB64: all,
    usage: usageSum,
    ...(lastTokens !== undefined ? { tokens: lastTokens } : {}),
  };
}

export async function grokCliChatCompletion(
  withUpstream: UpstreamPipe,
  account: Account,
  request: ChatCompletionRequest,
  fetchWithTimeout: FetchWithTimeout,
  estimateMessagesTokens: (messages: ChatCompletionRequest["messages"]) => number,
  generateId: () => string
): Promise<ProviderResult> {
  const nonStreamReq = { ...request, stream: false };
  const pipe = await withUpstream(account, async (working) => {
    const { response } = await grokCliUpstreamChat(fetchWithTimeout, working, nonStreamReq);
    return response;
  });
  if (!pipe.ok) {
    return failGrokCliChat(pipe.error, {
      deadAccount: pipe.deadAccount,
      tokens: parsePersistedTokens(pipe.tokensJson),
    });
  }

  const text = await pipe.response.text();
  const kind = classifyGrokCliError(pipe.response.status, text);
  const parsedTokens = parsePersistedTokens(pipe.tokensJson);
  if (!pipe.response.ok) {
    return failGrokCliChat(
      kind === "exhausted"
        ? GROK_CLI_CREDIT_SOFT_ERROR
        : `Grok CLI HTTP ${pipe.response.status}: ${text.slice(0, 300)}`,
      {
        quotaExhausted: kind === "exhausted",
        deadAccount: kind === "dead",
        tokens: parsedTokens,
      }
    );
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return { success: false, error: "Invalid JSON from Grok CLI upstream" };
  }

  const usage = data.usage || {};
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const total =
    Number(usage.total_tokens) ||
    promptTokens + completionTokens ||
    estimateMessagesTokens(request.messages);

  const resp: ChatCompletionResponse = {
    id: data.id || generateId(),
    object: "chat.completion",
    created: data.created || Math.floor(Date.now() / 1000),
    model: request.model,
    choices: data.choices || [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: total,
    },
  };

  return {
    success: true,
    response: resp,
    promptTokens,
    completionTokens,
    tokensUsed: total,
    creditsUsed: total,
    creditSource: "estimated",
    ...(parsedTokens !== undefined ? { tokens: parsedTokens } : {}),
  };
}

export async function grokCliChatCompletionStream(
  withUpstream: UpstreamPipe,
  account: Account,
  request: ChatCompletionRequest,
  fetchWithTimeout: FetchWithTimeout
): Promise<ProviderResult> {
  const streamReq = { ...request, stream: true };
  const pipe = await withUpstream(account, async (working) => {
    const { response } = await grokCliUpstreamChat(fetchWithTimeout, working, streamReq);
    return response;
  });
  if (!pipe.ok) {
    return failGrokCliChat(pipe.error, {
      deadAccount: pipe.deadAccount,
      tokens: parsePersistedTokens(pipe.tokensJson),
    });
  }

  const response = pipe.response;
  const parsedTokens = parsePersistedTokens(pipe.tokensJson);
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    const kind = classifyGrokCliError(response.status, text);
    return failGrokCliChat(
      kind === "exhausted"
        ? GROK_CLI_CREDIT_SOFT_ERROR
        : `Grok CLI stream HTTP ${response.status}: ${text.slice(0, 300)}`,
      {
        quotaExhausted: kind === "exhausted",
        deadAccount: kind === "dead",
        tokens: parsedTokens,
      }
    );
  }

  return {
    success: true,
    stream: response.body,
    promptTokens: 0,
    completionTokens: 0,
    tokensUsed: 0,
    ...(parsedTokens !== undefined ? { tokens: parsedTokens } : {}),
  };
}

export function localEstimatedQuota(account: Account): {
  quota: {
    limit: number;
    remaining: number;
    used: number;
    resetAt: null;
    source: "local-estimated";
  };
} {
  const limit =
    Number(account.quotaLimit) > 0 ? Number(account.quotaLimit) : GROK_CLI_TOKEN_LIMIT;
  const remainingRaw = account.quotaRemaining;
  const remaining = typeof remainingRaw === "number" ? remainingRaw : limit;
  const used = Math.max(0, limit - remaining);
  return {
    quota: {
      limit,
      remaining: Math.max(0, remaining),
      used,
      resetAt: null,
      source: "local-estimated",
    },
  };
}

export async function grokCliFetchQuota(
  fetchWithTimeout: FetchWithTimeout,
  account: Account
): Promise<{
  success: boolean;
  quota?: {
    limit: number;
    remaining: number;
    used: number;
    resetAt?: Date | string | null;
    source?: string;
  };
  exhausted?: boolean;
  error?: string;
}> {
  const tokens = readGrokCliTokens(account);
  if (!tokens?.access_token) {
    return { success: false, error: "No access_token" };
  }

  const PROBE_MODEL = resolveGrokCliUpstreamModel("grok-4.5");
  try {
    const response = await fetchWithTimeout(
      `${GROK_CLI_UPSTREAM_BASE}/chat/completions`,
      {
        method: "POST",
        headers: buildGrokCliHeaders(
          { ...tokens, email: account.email || tokens.email },
          PROBE_MODEL
        ),
        body: JSON.stringify({
          model: PROBE_MODEL,
          messages: [{ role: "user", content: "1" }],
          max_tokens: 1,
          stream: false,
        }),
      },
      config.providerQuotaTimeoutMs
    );

    const bodyText = await response.text().catch(() => "");
    const center = quotaFromGrokCliCenterSignals({
      headers: response.headers,
      body: bodyText,
      status: response.status,
    });

    if (center) {
      return {
        success: true,
        exhausted: center.exhausted,
        error: center.exhausted ? GROK_CLI_CREDIT_SOFT_ERROR : undefined,
        quota: {
          limit: center.limit,
          remaining: center.remaining,
          used: center.used,
          resetAt: center.resetAt,
          source: center.source,
        },
      };
    }

    if (!response.ok) {
      return {
        success: false,
        error: `Grok CLI quota probe HTTP ${response.status}`,
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: true,
      ...localEstimatedQuota(account),
      error: `quota probe failed: ${msg.slice(0, 120)}`,
    };
  }

  return { success: true, ...localEstimatedQuota(account) };
}
