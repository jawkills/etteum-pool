/** Anthropic / block-array → OpenAI chat message normalize for cli-chat-proxy. */

import type { ChatCompletionRequest } from "./base";

/** Collapse Anthropic/OpenAI content blocks to a single string. */
export function grokCliContentBlocksToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) return "";
  return (content as any[])
    .map((b) => {
      if (!b || typeof b !== "object") return "";
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "tool_result") return grokCliContentBlocksToText(b.content);
      if (typeof b.text === "string") return b.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Normalize the assistant / Anthropic-shaped messages for OpenAI chat.
 * Fixes live `400 invalid-argument Empty content block` when clients send
 * `content: [{type:"text", text:"…"}]` instead of a plain string.
 * Also lifts Anthropic tool_use / tool_result blocks into OpenAI tool_calls / role:tool.
 */
export function normalizeGrokCliMessagesForOpenAI(
  messages: ChatCompletionRequest["messages"]
): any[] {
  const out: any[] = [];

  for (const msg of messages) {
    if (msg.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: (msg as any).tool_call_id,
        content: grokCliContentBlocksToText(msg.content),
      });
      continue;
    }

    if (msg.role === "system") {
      out.push({
        role: "system",
        content: grokCliContentBlocksToText(msg.content),
      });
      continue;
    }

    if (
      msg.role === "assistant" &&
      Array.isArray((msg as any).tool_calls) &&
      (msg as any).tool_calls.length > 0
    ) {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? grokCliContentBlocksToText(msg.content)
            : null;
      out.push({
        role: "assistant",
        content,
        tool_calls: (msg as any).tool_calls,
      });
      continue;
    }

    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      if (msg.role === "assistant" && msg.content == null) continue;
      out.push({ role: msg.role, content: "" });
      continue;
    }

    const blocks = msg.content as any[];
    const textParts: string[] = [];
    const imageParts: any[] = [];
    const toolCalls: any[] = [];
    const toolResults: { id: string; content: string }[] = [];

    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") {
        textParts.push(b.text);
      } else if (b.type === "image_url" || b.type === "image") {
        imageParts.push(b);
      } else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id,
          type: "function",
          function: {
            name: b.name,
            arguments:
              typeof b.input === "string" ? b.input : JSON.stringify(b.input || {}),
          },
        });
      } else if (b.type === "tool_result") {
        let content = "";
        if (typeof b.content === "string") content = b.content;
        else if (Array.isArray(b.content)) content = grokCliContentBlocksToText(b.content);
        if (b.is_error) content = `[ERROR] ${content}`;
        toolResults.push({ id: b.tool_use_id, content });
      } else if (typeof b.text === "string") {
        textParts.push(b.text);
      }
    }

    const text = textParts.join("\n");

    if (msg.role === "user" && toolResults.length > 0) {
      for (const tr of toolResults) {
        out.push({ role: "tool", tool_call_id: tr.id, content: tr.content });
      }
      if (imageParts.length > 0) {
        const content: any[] = [];
        if (text) content.push({ type: "text", text });
        content.push(...imageParts);
        out.push({ role: "user", content });
      } else if (text) {
        out.push({ role: "user", content: text });
      }
      continue;
    }

    if (msg.role === "assistant" && toolCalls.length > 0) {
      out.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls,
      });
      continue;
    }

    if (imageParts.length > 0 && msg.role === "user") {
      const content: any[] = [];
      if (text) content.push({ type: "text", text });
      content.push(...imageParts);
      out.push({ role: "user", content });
      continue;
    }

    if (text || msg.role !== "assistant") {
      out.push({ role: msg.role, content: text });
    }
  }

  return out;
}
