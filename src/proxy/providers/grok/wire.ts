/**
 * Upstream HTTP wire for Grok (chat / image / refresh).
 * Free functions — provider class only owns session policy + locks.
 */

import type { Account } from "../../../db/schema";
import { config } from "../../../config";
import type { ChatCompletionRequest, ChatCompletionResponse, ProviderResult } from "../base";
import {
  GROK_CLIENT_ID,
  GROK_CREDIT_SOFT_ERROR,
  GROK_IMAGE_TIMEOUT_MS,
  GROK_TOKEN_URL,
  GROK_UPSTREAM_BASE,
} from "./constants";
import { type GrokTokens, normalizeGrokCpa } from "./auth";
import {
  classifyGrokError,
  parseRetryAfterMs,
  quotaFromGrokCenterSignals,
} from "./errors";
import {
  type GrokImageRequestOpts,
  type GrokImageResult,
  type GrokUsageNormalized,
  addGrokUsage,
  emptyGrokUsage,
  extractGrokImageGenerationResults,
  normalizeGrokUsage,
} from "./image";
import { normalizeGrokMessagesForOpenAI } from "./messages";
import { parseGrokModelId, resolveGrokUpstreamModel } from "./models";
import { buildGrokHeaders } from "./headers";
import {
  translateChatRequestToResponses,
  translateResponsesSseToChatSse,
  jsonResponsesToChatCompletion,
} from "./responses";
import {
  enrichTools,
  isUnknownToolError,
  stripInjectedBuiltins,
} from "./tools";
import { getCachedGrokRuntimeSettings } from "./settings";

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

export function readGrokTokens(account: Account): GrokTokens | null {
  try {
    const raw =
      typeof account.tokens === "string" ? JSON.parse(account.tokens as string) : account.tokens;
    if (!raw?.access_token) return null;
    return { ...raw, email: raw.email || account.email } as GrokTokens;
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

export function prepareGrokChatRequest(
  request: ChatCompletionRequest,
  settings = getCachedGrokRuntimeSettings()
): { request: ChatCompletionRequest; toolsPlan: ReturnType<typeof enrichTools> } {
  let stripped = request;
  if (request.tools?.length) {
    const cleaned = request.tools.filter(
      (t: any) => !(t && typeof t === "object" && t.type === "custom")
    );
    if (cleaned.length !== request.tools.length) {
      stripped = { ...request, tools: cleaned };
    }
  }
  const toolsPlan = enrichTools(stripped.tools, settings);
  const withTools: ChatCompletionRequest = {
    ...stripped,
    messages: normalizeGrokMessagesForOpenAI(
      stripped.messages
    ) as ChatCompletionRequest["messages"],
    tools: toolsPlan.tools,
  };
  return { request: withTools, toolsPlan };
}

export function failGrokChat(
  error: string,
  opts?: {
    deadAccount?: boolean;
    quotaExhausted?: boolean;
    rateLimited?: boolean;
    retryAfterMs?: number;
    tokens?: unknown;
  }
): ProviderResult {
  return {
    success: false,
    error,
    deadAccount: opts?.deadAccount,
    quotaExhausted: opts?.quotaExhausted,
    rateLimited: opts?.rateLimited,
    retryAfterMs: opts?.retryAfterMs,
    ...(opts?.tokens !== undefined ? { tokens: opts.tokens } : {}),
  };
}

export function failGrokImage(
  error: string,
  opts?: {
    deadAccount?: boolean;
    quotaExhausted?: boolean;
    rateLimited?: boolean;
    retryAfterMs?: number;
    tokens?: unknown;
  }
): GrokImageResult {
  return {
    success: false,
    error,
    deadAccount: opts?.deadAccount,
    quotaExhausted: opts?.quotaExhausted,
    ...(opts?.tokens !== undefined ? { tokens: opts.tokens } : {}),
  };
}

export async function grokUpstreamChat(
  fetchWithTimeout: FetchWithTimeout,
  account: Account,
  request: ChatCompletionRequest,
  opts?: {
    toolsOverride?: any[];
    sessionSeed?: string;
  }
): Promise<{ response: Response; tokens: GrokTokens }> {
  const tokens = readGrokTokens(account);
  if (!tokens?.access_token) throw new Error("No access_token for grok account");

  const prepared = prepareGrokChatRequest(request);
  const req = prepared.request;
  const parsed = parseGrokModelId(req.model);
  const model = parsed.upstream;

  // Responses API only — legacy chat/completions path removed (thinks-then-dies).
  const bodyObj = translateChatRequestToResponses(req) as unknown as Record<string, unknown>;
  if (opts?.toolsOverride !== undefined) {
    if (opts.toolsOverride && opts.toolsOverride.length > 0) {
      bodyObj.tools = opts.toolsOverride;
    } else {
      delete bodyObj.tools;
    }
  }

  const sessionSeed =
    opts?.sessionSeed ||
    (typeof (req as any).prompt_cache_key === "string"
      ? (req as any).prompt_cache_key
      : undefined);

  const response = await fetchWithTimeout(
    `${GROK_UPSTREAM_BASE}/responses`,
    {
      method: "POST",
      headers: buildGrokHeaders(
        { ...tokens, email: account.email },
        req.model || model,
        undefined,
        sessionSeed ? { sessionSeed } : {}
      ),
      body: JSON.stringify(bodyObj),
    },
    config.providerRequestTimeoutMs
  );
  return { response, tokens };
}

export async function grokUpstreamImage(
  fetchWithTimeout: FetchWithTimeout,
  account: Account,
  opts: { prompt: string; images?: string[]; model?: string }
): Promise<{ response: Response; tokens: GrokTokens }> {
  const tokens = readGrokTokens(account);
  if (!tokens?.access_token) throw new Error("No access_token for grok account");

  const model = resolveGrokUpstreamModel(opts.model || "grok-4.5");
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
    `${GROK_UPSTREAM_BASE}/responses`,
    {
      method: "POST",
      headers: buildGrokHeaders({ ...tokens, email: account.email }, model),
      body: JSON.stringify(body),
    },
    GROK_IMAGE_TIMEOUT_MS
  );
  return { response, tokens };
}

export async function grokDoRefresh(
  fetchWithTimeout: FetchWithTimeout,
  account: Account
): Promise<{ success: boolean; tokens?: string; error?: string }> {
  const tokens = readGrokTokens(account);
  if (!tokens?.refresh_token) return { success: false, error: "No refresh_token" };

  try {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: tokens.client_id || GROK_CLIENT_ID,
      refresh_token: tokens.refresh_token,
    });

    const response = await fetchWithTimeout(
      GROK_TOKEN_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "grok-shell/proxy",
        },
        body: form.toString(),
      },
      15000
    );

    const text = await response.text();
    if (!response.ok) {
      const kind = classifyGrokError(response.status, text);
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
    const next: GrokTokens = {
      ...tokens,
      access_token: data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      id_token: data.id_token || tokens.id_token,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      email: tokens.email || account.email,
    };

    if (next.id_token) {
      try {
        const normalized = normalizeGrokCpa({
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

export async function grokRunImageOnce(
  withUpstream: UpstreamPipe,
  account: Account,
  opts: { prompt: string; images?: string[]; model?: string },
  fetchWithTimeout: FetchWithTimeout
): Promise<GrokImageResult> {
  const pipe = await withUpstream(account, async (working) => {
    const { response } = await grokUpstreamImage(fetchWithTimeout, working, opts);
    return response;
  });
  if (!pipe.ok) {
    return failGrokImage(pipe.error, {
      deadAccount: pipe.deadAccount,
      tokens: parsePersistedTokens(pipe.tokensJson),
    });
  }

  const text = await pipe.response.text();
  const kind = classifyGrokError(pipe.response.status, text);
  const parsedTokens = parsePersistedTokens(pipe.tokensJson);
  if (!pipe.response.ok) {
    return failGrokImage(
      kind === "exhausted"
        ? GROK_CREDIT_SOFT_ERROR
        : kind === "rate_limited"
          ? `Grok capacity/rate-limit (image HTTP ${pipe.response.status})`
          : `Grok image HTTP ${pipe.response.status}: ${text.slice(0, 300)}`,
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
    return failGrokImage("Invalid JSON from Grok image upstream");
  }

  const imagesB64 = extractGrokImageGenerationResults(data);
  if (imagesB64.length === 0) {
    return failGrokImage("No image_generation_call result in upstream response", {
      tokens: parsedTokens,
    });
  }

  const usage = normalizeGrokUsage((data as any)?.usage);
  return {
    success: true,
    imagesB64,
    usage,
    ...(parsedTokens !== undefined ? { tokens: parsedTokens } : {}),
  };
}

export async function grokImageRequest(
  withUpstream: UpstreamPipe,
  account: Account,
  opts: GrokImageRequestOpts,
  fetchWithTimeout: FetchWithTimeout
): Promise<GrokImageResult> {
  const prompt = (opts.prompt || "").trim();
  if (!prompt) return { success: false, error: "prompt is required" };
  const images = (opts.images || []).filter(Boolean).slice(0, 3);
  const n = Math.min(4, Math.max(1, Number(opts.n) || 1));

  const all: string[] = [];
  let usageSum: GrokUsageNormalized = emptyGrokUsage();
  let lastTokens: unknown;
  let working = account;

  for (let i = 0; i < n; i++) {
    const one = await grokRunImageOnce(
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
    if (one.usage) usageSum = addGrokUsage(usageSum, one.usage);
  }

  return {
    success: true,
    imagesB64: all,
    usage: usageSum,
    ...(lastTokens !== undefined ? { tokens: lastTokens } : {}),
  };
}

export async function grokChatCompletion(
  withUpstream: UpstreamPipe,
  account: Account,
  request: ChatCompletionRequest,
  fetchWithTimeout: FetchWithTimeout,
  estimateMessagesTokens: (messages: ChatCompletionRequest["messages"]) => number,
  generateId: () => string
): Promise<ProviderResult> {
  const nonStreamReq = { ...request, stream: false };
  const settings = getCachedGrokRuntimeSettings();
  const prepared = prepareGrokChatRequest(nonStreamReq, settings);
  let toolsOverride = prepared.toolsPlan.tools;
  let searchDegraded = false;
  let injected = prepared.toolsPlan.injectedBuiltins;

  const runOnce = async (tools: any[] | undefined) => {
    return withUpstream(account, async (working) => {
      const { response } = await grokUpstreamChat(fetchWithTimeout, working, nonStreamReq, {
        toolsOverride: tools,
      });
      return response;
    });
  };

  let pipe = await runOnce(toolsOverride);
  if (!pipe.ok) {
    return failGrokChat(pipe.error, {
      deadAccount: pipe.deadAccount,
      tokens: parsePersistedTokens(pipe.tokensJson),
    });
  }

  if (
    !pipe.response.ok &&
    injected.length > 0 &&
    (await (async () => {
      const peek = await pipe.response.clone().text().catch(() => "");
      return isUnknownToolError(pipe.response.status, peek);
    })())
  ) {
    toolsOverride = stripInjectedBuiltins(toolsOverride, injected);
    injected = [];
    searchDegraded = true;
    console.warn("[Grok] search tools rejected by upstream; retrying without built-ins");
    pipe = await runOnce(toolsOverride);
    if (!pipe.ok) {
      return failGrokChat(pipe.error, {
        deadAccount: pipe.deadAccount,
        tokens: parsePersistedTokens(pipe.tokensJson),
      });
    }
  }

  const text = await pipe.response.text();
  const kind = classifyGrokError(pipe.response.status, text);
  const parsedTokens = parsePersistedTokens(pipe.tokensJson);
  if (!pipe.response.ok) {
    return failGrokChat(
      kind === "exhausted"
        ? GROK_CREDIT_SOFT_ERROR
        : kind === "rate_limited"
          ? `Grok capacity/rate-limit (HTTP ${pipe.response.status})`
          : `Grok HTTP ${pipe.response.status}: ${text.slice(0, 300)}`,
      {
        quotaExhausted: kind === "exhausted",
        deadAccount: kind === "dead",
        rateLimited: kind === "rate_limited",
        retryAfterMs: parseRetryAfterMs(pipe.response.headers),
        tokens: parsedTokens,
      }
    );
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return { success: false, error: "Invalid JSON from Grok upstream" };
  }

  const chat = jsonResponsesToChatCompletion(data, request.model);

  const usage = chat.usage || {};
  const promptTokens =
    Number(usage.prompt_tokens) ||
    Number((data.usage || {}).input_tokens) ||
    0;
  const completionTokens =
    Number(usage.completion_tokens) ||
    Number((data.usage || {}).output_tokens) ||
    0;
  const total =
    Number(usage.total_tokens) ||
    promptTokens + completionTokens ||
    estimateMessagesTokens(request.messages);

  const resp: ChatCompletionResponse = {
    ...chat,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: total,
    },
  };

  if (searchDegraded) {
    console.warn("[Grok] completed with searchDegraded=true");
  }

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

export async function grokChatCompletionStream(
  withUpstream: UpstreamPipe,
  account: Account,
  request: ChatCompletionRequest,
  fetchWithTimeout: FetchWithTimeout
): Promise<ProviderResult> {
  const streamReq = { ...request, stream: true };
  const settings = getCachedGrokRuntimeSettings();
  const prepared = prepareGrokChatRequest(streamReq, settings);
  let toolsOverride = prepared.toolsPlan.tools;
  let injected = prepared.toolsPlan.injectedBuiltins;
  let searchDegraded = false;

  const runOnce = async (tools: any[] | undefined) => {
    return withUpstream(account, async (working) => {
      const { response } = await grokUpstreamChat(fetchWithTimeout, working, streamReq, {
        toolsOverride: tools,
      });
      return response;
    });
  };

  let pipe = await runOnce(toolsOverride);
  if (!pipe.ok) {
    return failGrokChat(pipe.error, {
      deadAccount: pipe.deadAccount,
      tokens: parsePersistedTokens(pipe.tokensJson),
    });
  }

  if (
    !pipe.response.ok &&
    injected.length > 0 &&
    (await (async () => {
      const peek = await pipe.response.clone().text().catch(() => "");
      return isUnknownToolError(pipe.response.status, peek);
    })())
  ) {
    toolsOverride = stripInjectedBuiltins(toolsOverride, injected);
    injected = [];
    searchDegraded = true;
    console.warn("[Grok] search tools rejected by upstream (stream); retrying without built-ins");
    pipe = await runOnce(toolsOverride);
    if (!pipe.ok) {
      return failGrokChat(pipe.error, {
        deadAccount: pipe.deadAccount,
        tokens: parsePersistedTokens(pipe.tokensJson),
      });
    }
  }

  const response = pipe.response;
  const parsedTokens = parsePersistedTokens(pipe.tokensJson);
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    const kind = classifyGrokError(response.status, text);
    return failGrokChat(
      kind === "exhausted"
        ? GROK_CREDIT_SOFT_ERROR
        : kind === "rate_limited"
          ? `Grok capacity/rate-limit (stream HTTP ${response.status})`
          : `Grok stream HTTP ${response.status}: ${text.slice(0, 300)}`,
      {
        quotaExhausted: kind === "exhausted",
        deadAccount: kind === "dead",
        rateLimited: kind === "rate_limited",
        retryAfterMs: parseRetryAfterMs(response.headers),
        tokens: parsedTokens,
      }
    );
  }

  if (searchDegraded) {
    console.warn("[Grok] stream completed with searchDegraded=true");
  }

  const stream = response.body
    ? translateResponsesSseToChatSse(response.body, { model: request.model })
    : response.body;

  return {
    success: true,
    stream,
    promptTokens: 0,
    completionTokens: 0,
    tokensUsed: 0,
    ...(parsedTokens !== undefined ? { tokens: parsedTokens } : {}),
  };
}

/**
 * Local fallback when center does not return ratelimit headers/body.
 * Only mirrors what we already stored — never invents a fake ceiling.
 * limit=0 means "unknown" (warmup will not clobber prior DB values with -1/sentinel).
 */
export function localEstimatedQuota(account: Account): {
  quota: {
    limit: number;
    remaining: number;
    used: number;
    resetAt: null;
    source: "local-estimated";
  };
} {
  const storedLimit = Number(account.quotaLimit);
  const limit = Number.isFinite(storedLimit) && storedLimit > 0 ? storedLimit : 0;
  const remainingRaw = account.quotaRemaining;
  const remaining =
    typeof remainingRaw === "number" && Number.isFinite(remainingRaw)
      ? Math.max(0, remainingRaw)
      : limit > 0
        ? limit
        : 0;
  const used = limit > 0 ? Math.max(0, limit - remaining) : 0;
  return {
    quota: {
      limit,
      remaining,
      used,
      resetAt: null,
      source: "local-estimated",
    },
  };
}

export async function grokFetchQuota(
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
  const tokens = readGrokTokens(account);
  if (!tokens?.access_token) {
    return { success: false, error: "No access_token" };
  }

  const PROBE_MODEL = resolveGrokUpstreamModel("grok-4.5");
  try {
    // Probe body mirrors the wire path the chat request actually uses, so the
    // center treats it identically for credit/rate-limit accounting. The
    // Responses endpoint requires `input` rather than `messages`.
    const probeBody = {
      model: PROBE_MODEL,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "1" }],
        },
      ],
      stream: false,
      store: false,
      max_output_tokens: 1,
      reasoning: { summary: "concise", effort: "low" },
    };

    const response = await fetchWithTimeout(
      `${GROK_UPSTREAM_BASE}/responses`,
      {
        method: "POST",
        headers: buildGrokHeaders(
          { ...tokens, email: account.email || tokens.email },
          PROBE_MODEL
        ),
        body: JSON.stringify(probeBody),
      },
      config.providerQuotaTimeoutMs
    );

    const bodyText = await response.text().catch(() => "");
    const center = quotaFromGrokCenterSignals({
      headers: response.headers,
      body: bodyText,
      status: response.status,
    });

    if (center) {
      return {
        success: true,
        exhausted: center.exhausted,
        error: center.exhausted ? GROK_CREDIT_SOFT_ERROR : undefined,
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
        error: `Grok quota probe HTTP ${response.status}`,
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

// deprecated aliases
export const readGrokCliTokens = readGrokTokens;
export const prepareGrokCliChatRequest = (request: ChatCompletionRequest) =>
  prepareGrokChatRequest(request).request;
export const failGrokCliChat = failGrokChat;
export const failGrokCliImage = failGrokImage;
export const grokCliUpstreamChat = grokUpstreamChat;
export const grokCliUpstreamImage = grokUpstreamImage;
export const grokCliDoRefresh = grokDoRefresh;
export const grokCliImageRequest = grokImageRequest;
export const grokCliChatCompletion = grokChatCompletion;
export const grokCliChatCompletionStream = grokChatCompletionStream;
export const grokCliFetchQuota = grokFetchQuota;
