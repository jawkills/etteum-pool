/**
 * Upstream HTTP wire for Grok (chat / image / refresh).
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
import { parseGrokModelId, resolveGrokUpstreamModel } from "./models";
import { buildGrokHeaders } from "./headers";
import {
  translateChatRequestToResponses,
  translateResponsesSseToChatSse,
  jsonResponsesToChatCompletion,
} from "./responses";

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

/**
 * Whether to use the OpenAI Responses API endpoint for Grok chat.
 *
 * Default: true. The legacy /chat/completions path on cli-chat-proxy.grok.com
 * silently terminates after the reasoning phase for many interactive sessions,
 * which surfaces to clients as "grok thinks then dies". The Responses API
 * (/v1/responses) is the path the official grok-shell client and 9router use.
 *
 * Set GROK_CLI_USE_RESPONSES_API=false to fall back to the legacy endpoint
 * (e.g. for emergency rollback without a redeploy).
 */
const USE_RESPONSES_API =
  String(process.env.GROK_CLI_USE_RESPONSES_API ?? "true").toLowerCase() !== "false";

export async function grokCliUpstreamChat(
  fetchWithTimeout: FetchWithTimeout,
  account: Account,
  request: ChatCompletionRequest
): Promise<{ response: Response; tokens: GrokCliTokens }> {
  const tokens = readGrokCliTokens(account);
  if (!tokens?.access_token) throw new Error("No access_token for grok account");

  const req = prepareGrokCliChatRequest(request);
  const parsed = parseGrokModelId(req.model);
  const model = parsed.upstream;

  // Build body in the wire format the active endpoint expects.
  let endpointPath: string;
  let bodyObj: Record<string, unknown>;
  if (USE_RESPONSES_API) {
    // Responses API: translate OpenAI Chat Completions request shape.
    endpointPath = "/responses";
    bodyObj = translateChatRequestToResponses(req) as unknown as Record<string, unknown>;
  } else {
    // Legacy fallback: original Chat Completions body construction.
    endpointPath = "/chat/completions";
    bodyObj = { ...req, model, stream: !!req.stream };
    if (parsed.effortFromModelId && parsed.effort) {
      bodyObj.reasoning_effort = parsed.effort;
    } else if (bodyObj.reasoning_effort != null || (bodyObj as any).reasoningEffort != null) {
      const raw = String(bodyObj.reasoning_effort ?? (bodyObj as any).reasoningEffort).toLowerCase();
      if (raw === "max") bodyObj.reasoning_effort = "xhigh";
    }
  }

  const response = await fetchWithTimeout(
    `${GROK_CLI_UPSTREAM_BASE}${endpointPath}`,
    {
      method: "POST",
      headers: buildGrokHeaders({ ...tokens, email: account.email }, req.model || model),
      body: JSON.stringify(bodyObj),
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
    `${GROK_CLI_UPSTREAM_BASE}/responses`,
    {
      method: "POST",
      headers: buildGrokHeaders({ ...tokens, email: account.email }, model),
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
    return failGrokCliImage("Invalid JSON from Grok image upstream");
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
        : `Grok HTTP ${pipe.response.status}: ${text.slice(0, 300)}`,
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
    return { success: false, error: "Invalid JSON from Grok upstream" };
  }

  // Normalize the upstream response into OpenAI Chat Completions shape.
  // Responses API returns { output, usage: { input_tokens, output_tokens } };
  // the legacy Chat Completions path returns { choices, usage: { prompt_tokens } }.
  let chat: ChatCompletionResponse;
  if (USE_RESPONSES_API || Array.isArray(data.output)) {
    chat = jsonResponsesToChatCompletion(data, request.model);
  } else {
    chat = {
      id: data.id || generateId(),
      object: "chat.completion",
      created: data.created || Math.floor(Date.now() / 1000),
      model: request.model,
      choices: data.choices || [],
      usage: {
        prompt_tokens: Number(data.usage?.prompt_tokens) || 0,
        completion_tokens: Number(data.usage?.completion_tokens) || 0,
        total_tokens: Number(data.usage?.total_tokens) || 0,
      },
    };
  }

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
        : `Grok stream HTTP ${response.status}: ${text.slice(0, 300)}`,
      {
        quotaExhausted: kind === "exhausted",
        deadAccount: kind === "dead",
        tokens: parsedTokens,
      }
    );
  }

  // When talking to the Responses API, the upstream SSE uses Responses event
  // types (response.output_text.delta, response.reasoning_summary_text.delta,
  // response.completed, ...). Wrap it in a translator so downstream consumers
  // (wrapStreamWithUsageFinalizer, openAIStreamToAnthropic) still see standard
  // OpenAI Chat Completions SSE chunks. The legacy endpoint already emits
  // Chat Completions SSE so we pass it through unchanged.
  const upstreamBody = response.body;
  const stream = USE_RESPONSES_API && upstreamBody
    ? translateResponsesSseToChatSse(upstreamBody, { model: request.model })
    : upstreamBody;

  return {
    success: true,
    stream,
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

  const PROBE_MODEL = resolveGrokUpstreamModel("grok-4.5");
  try {
    // Probe body mirrors the wire path the chat request actually uses, so the
    // center treats it identically for credit/rate-limit accounting. The
    // Responses endpoint requires `input` rather than `messages`.
    const probeBody = USE_RESPONSES_API
      ? {
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
        }
      : {
          model: PROBE_MODEL,
          messages: [{ role: "user", content: "1" }],
          max_tokens: 1,
          stream: false,
        };

    const response = await fetchWithTimeout(
      `${GROK_CLI_UPSTREAM_BASE}${USE_RESPONSES_API ? "/responses" : "/chat/completions"}`,
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
