/**
 * Translators between OpenAI Chat Completions and the OpenAI Responses API
 * used by the Grok CLI chat upstream (cli-chat-proxy.grok.com).
 *
 * Why this exists:
 *   The Grok CLI proxy deprecated the legacy `/v1/chat/completions` endpoint for
 *   interactive sessions and now expects `/v1/responses`. Calls to the legacy
 *   path silently terminate after the reasoning phase without emitting output
 *   deltas, which surfaces to clients (opencode, Claude Code) as
 *   "grok thinks then dies". See docs/superpowers/plans/2026-07-20-grok-responses-api-migration.md.
 *
 *   To avoid rewriting the rest of the proxy, these translators keep the public
 *   contract in OpenAI Chat Completions shape and only swap the wire format on
 *   the way to/from upstream.
 *
 * Reference parity: decolua/9router uses the same endpoint and reasoning
 * continuation via `include: ["reasoning.encrypted_content"]`.
 */

import type { ChatCompletionRequest, ChatCompletionResponse } from "../base";
import { parseGrokModelId } from "./models";

// ---------------------------------------------------------------------------
// Request translation: Chat Completions -> Responses API
// ---------------------------------------------------------------------------

/** Default reasoning effort when neither model-id nor body specifies one. */
const DEFAULT_REASONING_EFFORT = "high";

/**
 * Fields the Responses API rejects (or silently ignores). The allowlist filter
 * after mapping enforces the remainder, but we delete these explicitly first
 * so a stray field on the inbound request never reaches upstream.
 */
const DROPPED_CHAT_FIELDS = new Set([
  "stream_options",
  "service_tier",
  "max_tokens",
  "max_completion_tokens",
  "n",
  "seed",
  "logprobs",
  "top_logprobs",
  "frequency_penalty",
  "presence_penalty",
  "logit_bias",
  "user",
  "previous_response_id",
  "prompt_cache_retention",
  "safety_identifier",
  "messages",
  "metadata",
  "stop",
]);

/** Inbound fields the Responses API accepts on the wire. */
const RESPONSES_REQUEST_ALLOWLIST = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "stream",
  "store",
  "reasoning",
  "include",
  "temperature",
  "top_p",
  "max_output_tokens",
  "parallel_tool_calls",
  "text",
  "prompt_cache_key",
]);

type ResponsesEffort = "low" | "medium" | "high" | "xhigh";

function normalizeEffortToken(raw: string | undefined): ResponsesEffort | null {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s === "low" || s === "medium" || s === "high") return s;
  if (s === "xhigh" || s === "max") return "xhigh";
  return null;
}

/** Flatten Anthropic/OpenAI content blocks into a plain text string. */
function contentBlocksToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) return "";
  return (content as any[])
    .map((b) => {
      if (!b || typeof b !== "object") return "";
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "tool_result") return contentBlocksToText(b.content);
      if (typeof b.text === "string") return b.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Pull image_url parts out of an OpenAI multimodal content block array. */
type InputContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

function collectImageParts(blocks: any[]): any[] {
  const out: any[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "image_url" || b.type === "image") {
      const url =
        typeof b.image_url === "string"
          ? b.image_url
          : b.image_url?.url || b.url || b.source?.url;
      if (typeof url === "string") out.push(url);
    }
  }
  return out;
}

export type ResponsesApiRequest = {
  model: string;
  input: any[];
  instructions?: string;
  stream: boolean;
  store: false;
  reasoning: { summary: "concise"; effort: ResponsesEffort };
  include: ["reasoning.encrypted_content"];
  tools?: any[];
  tool_choice?: any;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  parallel_tool_calls?: boolean;
};

/**
 * Convert an OpenAI Chat Completions request into a Responses API request body.
 *
 * Mapping summary:
 *   - system messages -> top-level `instructions` (joined with \n\n if many)
 *   - user text -> input item with role:"user", content parts of input_text
 *   - user image_url blocks -> input_image parts
 *   - assistant text -> input item with role:"assistant", content parts of output_text
 *   - assistant tool_calls -> top-level function_call input items
 *   - role:"tool" -> top-level function_call_output input items
 *   - reasoning.effort from model-id suffix (highest precedence) or body.reasoning_effort
 *   - default effort: "high"
 *   - store: false (never persist upstream)
 *   - include: ["reasoning.encrypted_content"] (multi-turn reasoning continuity)
 */
export function translateChatRequestToResponses(
  request: ChatCompletionRequest
): ResponsesApiRequest {
  const parsed = parseGrokModelId(request.model || "");
  const upstream = parsed.upstream;

  // --- system messages -> instructions ---
  const systemTexts: string[] = [];
  const conversational: any[] = [];
  for (const msg of request.messages || []) {
    if (msg.role === "system") {
      const text = contentBlocksToText(msg.content);
      if (text) systemTexts.push(text);
      continue;
    }
    conversational.push(msg);
  }

  // --- build input items ---
  const input: any[] = [];

  for (const msg of conversational) {
    if (msg.role === "tool") {
      // tool result -> function_call_output
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: contentBlocksToText(msg.content),
      });
      continue;
    }

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // assistant text first (if any), then each tool_call as its own item
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? contentBlocksToText(msg.content)
            : "";
      if (text) {
        input.push({
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      for (const tc of msg.tool_calls) {
        const fn = tc?.function || {};
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: fn.name,
          arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}),
        });
      }
      continue;
    }

    // plain text user/assistant message — possibly multimodal (text + images)
    if (typeof msg.content === "string") {
      input.push({
        role: msg.role,
        content: [
          {
            type: msg.role === "assistant" ? "output_text" : "input_text",
            text: msg.content,
          },
        ],
      });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      // null/missing content on assistant is fine; otherwise emit empty.
      if (msg.role === "assistant" && msg.content == null) continue;
      input.push({
        role: msg.role,
        content: [
          {
            type: msg.role === "assistant" ? "output_text" : "input_text",
            text: "",
          },
        ],
      });
      continue;
    }

    // Block array: text parts joined, image parts preserved.
    const blocks = msg.content as any[];
    const text = contentBlocksToText(blocks);
    const images = collectImageParts(blocks);
    const parts: InputContentPart[] = [];
    if (text) {
      parts.push({
        type: msg.role === "assistant" ? "output_text" : "input_text",
        text,
      });
    }
    for (const url of images) {
      parts.push({ type: "input_image", image_url: url });
    }
    if (parts.length === 0 && msg.role !== "assistant") {
      parts.push({ type: "input_text", text: "" });
    }
    if (parts.length > 0) {
      input.push({ role: msg.role, content: parts });
    }
  }

  // --- tools ---
  let tools: any[] | undefined;
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    const mapped = request.tools
      .filter((t: any) => t && typeof t === "object" && t.type !== "custom")
      .map((t: any) => {
        if (t.type === "function" && t.function) {
          return {
            type: "function",
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters || { type: "object", properties: {} },
            strict: false,
          };
        }
        // Already Responses-shaped or unknown — pass through.
        return t;
      });
    if (mapped.length > 0) tools = mapped;
  }

  // --- tool_choice ---
  let toolChoice: any = undefined;
  if (request.tool_choice != null) {
    const tc = request.tool_choice;
    if (typeof tc === "string") {
      toolChoice = tc; // "auto" | "none" | "required"
    } else if (tc?.type === "function" && tc?.function?.name) {
      toolChoice = { type: "function", name: tc.function.name };
    } else if (tc?.type === "auto" || tc?.type === "none" || tc?.type === "required") {
      toolChoice = tc.type;
    }
  }

  // --- reasoning effort ---
  let effort: ResponsesEffort =
    (parsed.effortFromModelId && (parsed.effort as ResponsesEffort)) ||
    normalizeEffortToken((request as any).reasoning_effort) ||
    DEFAULT_REASONING_EFFORT;
  if (!effort) effort = DEFAULT_REASONING_EFFORT;

  // --- assemble body ---
  const body: any = {
    model: upstream,
    input,
    stream: request.stream !== false,
    store: false,
    reasoning: { summary: "concise", effort },
    include: ["reasoning.encrypted_content"],
  };

  if (systemTexts.length > 0) body.instructions = systemTexts.join("\n\n");
  if (tools) body.tools = tools;
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  if (typeof request.temperature === "number") body.temperature = request.temperature;
  if (typeof request.top_p === "number") body.top_p = request.top_p;

  const maxOut =
    (request as any).max_output_tokens ??
    (typeof (request as any).max_tokens === "number" ? (request as any).max_tokens : undefined);
  if (typeof maxOut === "number" && maxOut > 0) body.max_output_tokens = maxOut;

  if (typeof (request as any).parallel_tool_calls === "boolean") {
    body.parallel_tool_calls = (request as any).parallel_tool_calls;
  }

  // --- safety net: drop any field the Responses API does not accept ---
  for (const key of Object.keys(body)) {
    if (!RESPONSES_REQUEST_ALLOWLIST.has(key)) delete body[key];
  }
  // Drop any other stray inbound field that came through the spread.
  for (const key of Object.keys(request as any)) {
    if (DROPPED_CHAT_FIELDS.has(key)) delete body[key];
  }

  return body as ResponsesApiRequest;
}

// ---------------------------------------------------------------------------
// Non-streaming response translation: Responses JSON -> ChatCompletion JSON
// ---------------------------------------------------------------------------

export type ResponsesApiOutput = {
  id?: string;
  model?: string;
  created?: number;
  output?: any[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
};

function summarizeReasoning(items: any[]): string {
  // Each reasoning item may have a `summary` array of {type:"summary_text", text}.
  const parts: string[] = [];
  for (const item of items) {
    if (!item || item.type !== "reasoning") continue;
    const summary = item.summary;
    if (Array.isArray(summary)) {
      for (const s of summary) {
        if (s?.text) parts.push(String(s.text));
      }
    } else if (typeof item.content === "string") {
      parts.push(item.content);
    }
  }
  return parts.join("\n");
}

function collectMessageText(items: any[]): string {
  // Concatenate output_text parts from message output items.
  const parts: string[] = [];
  for (const item of items) {
    if (!item || item.type !== "message") continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("");
}

function collectToolCalls(items: any[]): any[] {
  const calls: any[] = [];
  for (const item of items) {
    if (!item || item.type !== "function_call") continue;
    calls.push({
      id: item.call_id || item.id,
      type: "function",
      function: {
        name: item.name,
        arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
      },
    });
  }
  return calls;
}

/** Convert a non-streaming Responses API body into a Chat Completions response. */
export function jsonResponsesToChatCompletion(
  body: ResponsesApiOutput,
  fallbackModel = "grok-4.5"
): ChatCompletionResponse {
  const items = Array.isArray(body.output) ? body.output : [];
  const text = collectMessageText(items);
  const reasoning = summarizeReasoning(items);
  const toolCalls = collectToolCalls(items);

  const message: any = { role: "assistant", content: text };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) {
    // When tool_calls are present, OpenAI convention sets content to null.
    message.tool_calls = toolCalls;
    if (!text) message.content = null;
  }

  const usage = body.usage || {};
  const promptTokens = Number(usage.input_tokens) || 0;
  const completionTokens = Number(usage.output_tokens) || 0;
  const total =
    Number(usage.total_tokens) || promptTokens + completionTokens;

  return {
    id: body.id || `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: body.created || Math.floor(Date.now() / 1000),
    model: body.model || fallbackModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: total,
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming response translation: Responses SSE -> Chat Completions SSE
// ---------------------------------------------------------------------------

function encodeSse(data: string): Uint8Array {
  return new TextEncoder().encode(`data: ${data}\n\n`);
}

function chatChunk(id: string, model: string, delta: any, extra?: any): Uint8Array {
  const payload: any = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null,
      },
    ],
  };
  if (extra) Object.assign(payload, extra);
  return encodeSse(JSON.stringify(payload));
}

function chatFinalChunk(
  id: string,
  model: string,
  finishReason: string,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): Uint8Array {
  const payload: any = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
  };
  if (usage) payload.usage = usage;
  return encodeSse(JSON.stringify(payload));
}

function errorChunk(id: string, model: string, message: string): Uint8Array {
  const payload = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
    error: { message, type: "upstream_error" },
  };
  return encodeSse(JSON.stringify(payload));
}

/**
 * Translate a Responses API SSE stream into a Chat Completions SSE stream.
 *
 * The implementation:
 *   - buffers partial SSE events (split on \n\n) so chunk boundaries do not
 *     corrupt JSON
 *   - keeps a counter of function calls seen so finish_reason is "tool_calls"
 *     when any tool call was emitted
 *   - always emits a final chunk with finish_reason + (optionally) usage and
 *     terminates with `data: [DONE]`, even when upstream closes early or only
 *     produced reasoning. This is the core of the "thinks then dies" fix.
 */
export function translateResponsesSseToChatSse(
  upstream: ReadableStream<Uint8Array>,
  opts: { id?: string; model?: string } = {}
): ReadableStream<Uint8Array> {
  const id = opts.id || `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
  const model = opts.model || "grok-4.5";

  const decoder = new TextDecoder();
  let buffer = "";
  let roleSent = false;
  let hadToolCalls = false;
  // emittedFinal tracks whether we have already emitted a final chunk
  // (finish_reason) for this stream. The [DONE] marker and controller.close()
  // are always emitted exactly once in the finally block; only the final chunk
  // is gated by this flag so we don't double-emit finish_reason.
  let emittedFinal = false;
  let closed = false;

  const safeEnqueue = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) => {
    if (closed) return;
    try {
      controller.enqueue(chunk);
    } catch {
      closed = true;
    }
  };

  const safeClose = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch {
      /* already closed */
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      const ctx = {
        id,
        model,
        getRoleSent: () => roleSent,
        setRoleSent: () => {
          roleSent = true;
        },
        markToolCall: () => {
          hadToolCalls = true;
        },
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";
          for (const raw of events) {
            const result = handleEvent(controller, raw, ctx);
            if (result?.emittedFinal) emittedFinal = true;
          }
        }
        // Flush any trailing buffered event.
        if (buffer.trim()) {
          const result = handleEvent(controller, buffer, ctx);
          if (result?.emittedFinal) emittedFinal = true;
          buffer = "";
        }
      } catch (err) {
        // Network/decode error — surface as an error chunk then close.
        const msg = err instanceof Error ? err.message : String(err);
        safeEnqueue(controller, errorChunk(id, model, `Stream error: ${msg}`));
      } finally {
        // Always emit a final chunk (with finish_reason) if upstream didn't
        // already send response.completed, then always emit [DONE] and close.
        // This is the core of the "thinks then dies" fix: even when upstream
        // closes early or only produced reasoning, the client receives a
        // properly terminated Chat Completions stream.
        if (!emittedFinal) {
          safeEnqueue(
            controller,
            chatFinalChunk(id, model, hadToolCalls ? "tool_calls" : "stop")
          );
        }
        safeEnqueue(controller, encodeSse("[DONE]"));
        safeClose(controller);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        /* ignore */
      }
    },
  });

  function handleEvent(
    controller: ReadableStreamDefaultController<Uint8Array>,
    rawEvent: string,
    ctx: {
      id: string;
      model: string;
      getRoleSent: () => boolean;
      setRoleSent: () => void;
      markToolCall: () => void;
    }
  ): { emittedFinal?: boolean } | void {
    if (!rawEvent.trim()) return;
    // Extract the data: payload (could span multiple lines).
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      else if (line.startsWith("data:")) dataLines.push(line.slice(5));
    }
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n").trim();
    if (!payload || payload === "[DONE]") return;

    let evt: any;
    try {
      evt = JSON.parse(payload);
    } catch {
      return; // malformed event — skip
    }
    if (!evt || typeof evt !== "object") return;

    const type: string = evt.type || "";
    const data = evt.response || evt;

    switch (type) {
      case "response.output_text.delta": {
        const text = typeof evt.delta === "string" ? evt.delta : "";
        if (!text) break;
        const delta: any = { content: text };
        if (!ctx.getRoleSent()) {
          delta.role = "assistant";
          ctx.setRoleSent();
        }
        safeEnqueue(controller, chatChunk(ctx.id, ctx.model, delta));
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const text = typeof evt.delta === "string" ? evt.delta : "";
        if (!text) break;
        const delta: any = { reasoning_content: text };
        if (!ctx.getRoleSent()) {
          delta.role = "assistant";
          ctx.setRoleSent();
        }
        safeEnqueue(controller, chatChunk(ctx.id, ctx.model, delta));
        break;
      }
      case "response.output_item.added": {
        const item = evt.item;
        if (item?.type === "function_call") {
          ctx.markToolCall();
          const delta: any = {
            tool_calls: [
              {
                index: Number(evt.output_index ?? 0),
                id: item.call_id || item.id,
                type: "function",
                function: {
                  name: item.name,
                  arguments: "",
                },
              },
            ],
          };
          if (!ctx.getRoleSent()) {
            delta.role = "assistant";
            ctx.setRoleSent();
          }
          safeEnqueue(controller, chatChunk(ctx.id, ctx.model, delta));
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const delta = typeof evt.delta === "string" ? evt.delta : "";
        if (!delta) break;
        safeEnqueue(
          controller,
          chatChunk(ctx.id, ctx.model, {
            tool_calls: [
              {
                index: Number(evt.output_index ?? 0),
                function: { arguments: delta },
              },
            ],
          })
        );
        break;
      }
      case "response.completed": {
        const usage = data?.usage;
        const promptTokens = Number(usage?.input_tokens) || 0;
        const completionTokens = Number(usage?.output_tokens) || 0;
        const total = Number(usage?.total_tokens) || promptTokens + completionTokens;
        safeEnqueue(
          controller,
          chatFinalChunk(
            ctx.id,
            ctx.model,
            hadToolCalls ? "tool_calls" : "stop",
            {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: total,
            }
          )
        );
        return { emittedFinal: true };
      }
      case "response.failed":
      case "error": {
        const msg =
          data?.error?.message ||
          evt?.error?.message ||
          evt?.message ||
          "Upstream response failed";
        safeEnqueue(controller, errorChunk(ctx.id, ctx.model, msg));
        return { emittedFinal: true };
      }
      default:
        // Unknown event types are ignored — the stream continues.
        // This includes response.created, response.in_progress,
        // response.output_item.done, etc.
        break;
    }
    return;
  }
}
