import { describe, expect, test } from "bun:test";
import {
  translateChatRequestToResponses,
  translateResponsesSseToChatSse,
  jsonResponsesToChatCompletion,
} from "./responses";
import type { ChatCompletionRequest } from "../base";

// Helper: drain a ReadableStream<Uint8Array> into a string.
async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

// Helper: parse SSE into a list of {event, data} pairs.
function parseSse(sse: string): Array<{ event?: string; data: string }> {
  const events: Array<{ event?: string; data: string }> = [];
  for (const block of sse.split("\n\n")) {
    if (!block.trim()) continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      else if (line.startsWith("data:")) dataLines.push(line.slice(5));
    }
    if (dataLines.length === 0) continue;
    events.push({ event, data: dataLines.join("\n") });
  }
  return events;
}

// Helper: build a SSE block from an event object.
function sseChunk(obj: unknown): string {
  return `event: ${(obj as any).type}\ndata: ${JSON.stringify(obj)}\n\n`;
}

describe("translateChatRequestToResponses", () => {
  test("maps plain text user/assistant messages to input array", () => {
    const req: ChatCompletionRequest = {
      model: "grok-4.5",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "How are you?" },
      ],
      stream: true,
    } as any;

    const out = translateChatRequestToResponses(req);
    expect(out.model).toBe("grok-4.5");
    expect(out.stream).toBe(true);
    expect(out.store).toBe(false);
    expect(out.instructions).toBeUndefined();
    expect(out.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Hi" }] },
      { role: "assistant", content: [{ type: "output_text", text: "Hello!" }] },
      { role: "user", content: [{ type: "input_text", text: "How are you?" }] },
    ]);
  });

  test("lifts system message to top-level instructions", () => {
    const req = {
      model: "grok-4.5",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "ping" },
      ],
      stream: false,
    } as any;

    const out = translateChatRequestToResponses(req);
    expect(out.instructions).toBe("You are helpful.");
    expect(out.input).toHaveLength(1);
    expect((out.input as any[])[0].role).toBe("user");
  });

  test("merges multiple system messages into instructions (joined with \\n\\n)", () => {
    const req = {
      model: "grok-4.5",
      messages: [
        { role: "system", content: "Rule 1" },
        { role: "system", content: "Rule 2" },
        { role: "user", content: "go" },
      ],
    } as any;

    const out = translateChatRequestToResponses(req);
    expect(out.instructions).toBe("Rule 1\n\nRule 2");
  });

  test("lifts assistant tool_calls into function_call input items", () => {
    const req = {
      model: "grok-4.5",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"SF"}' },
            },
          ],
        },
      ],
    } as any;

    const out = translateChatRequestToResponses(req);
    const input = out.input as any[];
    // user message + assistant text + function_call = 3 items
    expect(input).toHaveLength(3);
    expect(input[1]).toEqual({
      role: "assistant",
      content: [{ type: "output_text", text: "Let me check." }],
    });
    expect(input[2]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "get_weather",
      arguments: '{"city":"SF"}',
    });
  });

  test("maps role:tool to function_call_output", () => {
    const req = {
      model: "grok-4.5",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"temp":72}' },
      ],
    } as any;

    const out = translateChatRequestToResponses(req);
    const last = (out.input as any[]).at(-1);
    expect(last).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: '{"temp":72}',
    });
  });

  test("assistant with tool_calls and null content emits function_call only", () => {
    const req = {
      model: "grok-4.5",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "do_thing", arguments: "{}" },
            },
          ],
        },
      ],
    } as any;

    const out = translateChatRequestToResponses(req);
    expect(out.input).toEqual([
      {
        type: "function_call",
        call_id: "c1",
        name: "do_thing",
        arguments: "{}",
      },
    ]);
  });

  test("maps image_url content blocks to input_image parts", () => {
    const req = {
      model: "grok-4.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,abc" },
            },
          ],
        },
      ],
    } as any;

    const out = translateChatRequestToResponses(req);
    expect(out.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "what is this?" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,abc",
          },
        ],
      },
    ]);
  });

  test("translates OpenAI function tools to Responses function tools", () => {
    const req = {
      model: "grok-4.5",
      messages: [{ role: "user", content: "go" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: {} },
          },
        },
        { type: "custom" }, // must be stripped
      ],
    } as any;

    const out = translateChatRequestToResponses(req);
    expect(out.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ]);
  });

  test("drops disallowed fields (stream_options, service_tier, max_tokens, ...)", () => {
    const req = {
      model: "grok-4.5",
      messages: [{ role: "user", content: "go" }],
      stream: true,
      stream_options: { include_usage: true },
      service_tier: "auto",
      max_tokens: 1000,
      max_completion_tokens: 2000,
      n: 1,
      seed: 42,
      logprobs: false,
      frequency_penalty: 0,
      presence_penalty: 0,
      logit_bias: {},
      user: "u1",
      previous_response_id: "resp_x",
    } as any;

    const out = translateChatRequestToResponses(req) as any;
    expect(out.stream_options).toBeUndefined();
    expect(out.service_tier).toBeUndefined();
    expect(out.max_tokens).toBeUndefined();
    expect(out.max_completion_tokens).toBeUndefined();
    expect(out.n).toBeUndefined();
    expect(out.seed).toBeUndefined();
    expect(out.logprobs).toBeUndefined();
    expect(out.frequency_penalty).toBeUndefined();
    expect(out.presence_penalty).toBeUndefined();
    expect(out.logit_bias).toBeUndefined();
    expect(out.user).toBeUndefined();
    expect(out.previous_response_id).toBeUndefined();
    // max_output_tokens may be set from max_tokens but the others are gone.
  });

  test("passes through temperature, top_p, max_output_tokens (mapped from max_tokens)", () => {
    const req = {
      model: "grok-4.5",
      messages: [{ role: "user", content: "go" }],
      temperature: 0.5,
      top_p: 0.9,
      max_tokens: 250,
    } as any;

    const out = translateChatRequestToResponses(req) as any;
    expect(out.temperature).toBe(0.5);
    expect(out.top_p).toBe(0.9);
    expect(out.max_output_tokens).toBe(250);
  });

  test("sets reasoning from model-id effort suffix (grok-4.5-high)", () => {
    const req = {
      model: "grok-4.5-high",
      messages: [{ role: "user", content: "go" }],
    } as any;
    const out = translateChatRequestToResponses(req) as any;
    expect(out.reasoning).toEqual({
      summary: "concise",
      effort: "high",
    });
    expect(out.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("maps reasoning_effort=max in body to effort=xhigh", () => {
    const req = {
      model: "grok-4.5",
      messages: [{ role: "user", content: "go" }],
      reasoning_effort: "max",
    } as any;
    const out = translateChatRequestToResponses(req) as any;
    expect(out.reasoning.effort).toBe("xhigh");
  });

  test("defaults effort to high when none provided", () => {
    const req = {
      model: "grok-4.5",
      messages: [{ role: "user", content: "go" }],
    } as any;
    const out = translateChatRequestToResponses(req) as any;
    expect(out.reasoning.effort).toBe("high");
  });

  test("model-id effort overrides body reasoning_effort", () => {
    const req = {
      model: "grok-4.5-low",
      messages: [{ role: "user", content: "go" }],
      reasoning_effort: "high",
    } as any;
    const out = translateChatRequestToResponses(req) as any;
    expect(out.reasoning.effort).toBe("low");
  });

  test("translates tool_choice variants", () => {
    expect(
      translateChatRequestToResponses({
        model: "grok-4.5",
        messages: [{ role: "user", content: "go" }],
        tool_choice: "auto",
      } as any).tool_choice
    ).toBe("auto");

    expect(
      translateChatRequestToResponses({
        model: "grok-4.5",
        messages: [{ role: "user", content: "go" }],
        tool_choice: { type: "function", function: { name: "x" } },
      } as any).tool_choice
    ).toEqual({ type: "function", name: "x" });
  });

  test("flattens Anthropic-style content block arrays to text", () => {
    // Claude Code / opencode send arrays of {type:"text", text:"..."}.
    const req = {
      model: "grok-4.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "line 1" },
            { type: "text", text: "line 2" },
          ],
        },
      ],
    } as any;

    const out = translateChatRequestToResponses(req);
    expect(out.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "line 1\nline 2" }],
      },
    ]);
  });
});

describe("jsonResponsesToChatCompletion", () => {
  test("converts a message + reasoning response to chat.completion", () => {
    const resp = {
      id: "resp_123",
      model: "grok-4.5",
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Thinking..." }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello!" }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };

    const chat = jsonResponsesToChatCompletion(resp, "req-xyz");
    expect(chat.id).toBe("resp_123");
    expect(chat.object).toBe("chat.completion");
    expect(chat.model).toBe("grok-4.5");
    expect(chat.choices).toHaveLength(1);
    const choice = chat.choices[0] as any;
    expect(choice.message.role).toBe("assistant");
    expect(choice.message.content).toBe("Hello!");
    expect(choice.message.reasoning_content).toBe("Thinking...");
    expect(choice.finish_reason).toBe("stop");
    expect(chat.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  test("lifts function_call output items into tool_calls", () => {
    const resp = {
      id: "resp_1",
      model: "grok-4.5",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"city":"SF"}',
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    };

    const chat = jsonResponsesToChatCompletion(resp, "req-x");
    const choice = chat.choices[0] as any;
    expect(choice.message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"SF"}' },
      },
    ]);
    expect(choice.finish_reason).toBe("tool_calls");
  });

  test("empty output produces empty content with finish_reason stop", () => {
    const chat = jsonResponsesToChatCompletion(
      { id: "r", model: "grok-4.5", output: [], usage: {} },
      "req"
    );
    const choice = chat.choices[0] as any;
    expect(choice.message.content).toBe("");
    expect(choice.finish_reason).toBe("stop");
  });

  test("handles missing usage gracefully (zero defaults)", () => {
    const chat = jsonResponsesToChatCompletion(
      { id: "r", model: "grok-4.5", output: [] },
      "req"
    );
    expect(chat.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });
});

describe("translateResponsesSseToChatSse", () => {
  test("emits chat.completion.chunk for output_text deltas and ends with [DONE]", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            sseChunk({ type: "response.created", response: { id: "resp_1" } })
          )
        );
        controller.enqueue(
          encoder.encode(
            sseChunk({
              type: "response.output_text.delta",
              item_id: "msg_1",
              output_index: 0,
              content_index: 0,
              delta: "Hello",
            })
          )
        );
        controller.enqueue(
          encoder.encode(
            sseChunk({
              type: "response.output_text.delta",
              item_id: "msg_1",
              output_index: 0,
              content_index: 0,
              delta: " world",
            })
          )
        );
        controller.enqueue(
          encoder.encode(
            sseChunk({
              type: "response.completed",
              response: {
                id: "resp_1",
                usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
              },
            })
          )
        );
        controller.close();
      },
    });

    const out = await drainStream(translateResponsesSseToChatSse(upstream));
    const events = parseSse(out);

    // Last must be [DONE]
    expect(events.at(-1)?.data).toBe("[DONE]");

    // Penultimate should be the final chunk with finish_reason + usage
    const finalChunk = JSON.parse(events.at(-2)!.data);
    expect(finalChunk.object).toBe("chat.completion.chunk");
    expect(finalChunk.choices[0].finish_reason).toBe("stop");
    expect(finalChunk.usage.total_tokens).toBe(5);

    // Middle chunks: deltas
    const deltas = events.slice(0, -2).map((e) => JSON.parse(e.data));
    expect(deltas).toHaveLength(2);
    expect(deltas[0].choices[0].delta.content).toBe("Hello");
    expect(deltas[1].choices[0].delta.content).toBe(" world");
    // First chunk carries the role
    expect(deltas[0].choices[0].delta.role).toBe("assistant");
  });

  test("emits reasoning_content for reasoning_summary_text.delta (the 'thinking' fix)", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(sseChunk({ type: "response.created", response: {} }))
        );
        controller.enqueue(
          encoder.encode(
            sseChunk({
              type: "response.reasoning_summary_text.delta",
              item_id: "rs_1",
              output_index: 0,
              content_index: 0,
              delta: "I should think",
            })
          )
        );
        controller.enqueue(
          encoder.encode(
            sseChunk({
              type: "response.reasoning_summary_text.delta",
              item_id: "rs_1",
              output_index: 0,
              content_index: 0,
              delta: " about this",
            })
          )
        );
        controller.enqueue(
          encoder.encode(
            sseChunk({
              type: "response.output_text.delta",
              item_id: "msg_1",
              output_index: 1,
              content_index: 0,
              delta: "Answer!",
            })
          )
        );
        controller.enqueue(
          encoder.encode(
            sseChunk({
              type: "response.completed",
              response: { usage: { input_tokens: 1, output_tokens: 1 } },
            })
          )
        );
        controller.close();
      },
    });

    const out = await drainStream(translateResponsesSseToChatSse(upstream));
    const events = parseSse(out).filter((e) => e.data !== "[DONE]");
    const chunks = events.map((e) => JSON.parse(e.data));

    const reasoningChunks = chunks.filter((c: any) => c.choices?.[0]?.delta?.reasoning_content);
    expect(reasoningChunks).toHaveLength(2);
    expect((reasoningChunks[0] as any).choices[0].delta.reasoning_content).toBe(
      "I should think"
    );

    const textChunks = chunks.filter((c: any) => c.choices?.[0]?.delta?.content);
    expect(textChunks).toHaveLength(1);
    expect((textChunks[0] as any).choices[0].delta.content).toBe("Answer!");
  });

  test("thinking-only response (no output_text) still finishes cleanly (regression)", async () => {
    // This is the bug we are fixing: grok thinks then "terminates" without output.
    // The translator must still emit a final chunk with finish_reason + [DONE]
    // so the client does not see a truncated stream.
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(sseChunk({ type: "response.created", response: {} }))
        );
        controller.enqueue(
          encoder.encode(
            sseChunk({
              type: "response.reasoning_summary_text.delta",
              delta: "thinking...",
            })
          )
        );
        controller.enqueue(
          encoder.encode(
            sseChunk({
              type: "response.completed",
              response: { usage: { input_tokens: 1, output_tokens: 1 } },
            })
          )
        );
        controller.close();
      },
    });

    const out = await drainStream(translateResponsesSseToChatSse(upstream));
    const events = parseSse(out);

    // Must end with [DONE]
    expect(events.at(-1)?.data).toBe("[DONE]");

    // Must have a final chunk with finish_reason
    const finalChunk = JSON.parse(events.at(-2)!.data);
    expect(finalChunk.choices[0].finish_reason).toBe("stop");
  });

  test("streams tool_call name on output_item.added + arguments via deltas", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(sseChunk({ type: "response.created", response: {} }))
        );
        // A function_call output item appears
        controller.enqueue(
          encoder.encode(
            sseChunk({
              type: "response.output_item.added",
              output_index: 0,
              item: {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "get_weather",
                arguments: "",
              },
            })
          )
        );
        // Arguments stream in deltas
        controller.enqueue(
          encoder.encode(
            sseChunk({
              type: "response.function_call_arguments.delta",
              output_index: 0,
              item_id: "fc_1",
              delta: '{"city":',
            })
          )
        );
        controller.enqueue(
          encoder.encode(
            sseChunk({
              type: "response.function_call_arguments.delta",
              output_index: 0,
              item_id: "fc_1",
              delta: '"SF"}',
            })
          )
        );
        controller.enqueue(
          encoder.encode(
            sseChunk({
              type: "response.completed",
              response: { usage: { input_tokens: 1, output_tokens: 1 } },
            })
          )
        );
        controller.close();
      },
    });

    const out = await drainStream(translateResponsesSseToChatSse(upstream));
    const events = parseSse(out).filter((e) => e.data !== "[DONE]");
    const chunks = events.map((e) => JSON.parse(e.data));

    // First tool chunk: name + empty arguments
    const firstTool = chunks.find((c: any) =>
      c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name
    ) as any;
    expect(firstTool).toBeTruthy();
    expect(firstTool.choices[0].delta.tool_calls[0]).toMatchObject({
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "get_weather" },
    });

    // Argument deltas
    const argChunks = chunks.filter(
      (c: any) => c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments
    );
    expect(argChunks).toHaveLength(2);
    expect(
      (argChunks[0] as any).choices[0].delta.tool_calls[0].function.arguments
    ).toBe('{"city":');
    expect(
      (argChunks[1] as any).choices[0].delta.tool_calls[0].function.arguments
    ).toBe('"SF"}');

    // Final chunk finish_reason should be tool_calls
    const finalChunk = chunks.at(-1) as any;
    expect(finalChunk.choices[0].finish_reason).toBe("tool_calls");
  });

  test("emits error chunk for response.failed", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(sseChunk({ type: "response.created", response: {} }))
        );
        controller.enqueue(
          encoder.encode(
            sseChunk({
              type: "response.failed",
              response: {
                error: { message: "upstream blew up" },
              },
            })
          )
        );
        controller.close();
      },
    });

    const out = await drainStream(translateResponsesSseToChatSse(upstream));
    const events = parseSse(out);

    // Should end with [DONE] even on failure (so client finishes cleanly)
    expect(events.at(-1)?.data).toBe("[DONE]");

    const errChunk = JSON.parse(
      events.find((e) => {
        try {
          const d = JSON.parse(e.data);
          return d.error;
        } catch {
          return false;
        }
      })!.data
    );
    expect(errChunk.error.message).toContain("upstream blew up");
  });

  test("handles partial SSE chunks across read boundaries", async () => {
    // Split a single event across two read() calls to ensure buffering works.
    const fullEvent =
      sseChunk({
        type: "response.output_text.delta",
        delta: "X",
      }) + sseChunk({ type: "response.completed", response: {} });

    const mid = Math.floor(fullEvent.length / 2);
    const part1 = fullEvent.slice(0, mid);
    const part2 = fullEvent.slice(mid);

    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(part1));
        controller.enqueue(encoder.encode(part2));
        controller.close();
      },
    });

    const out = await drainStream(translateResponsesSseToChatSse(upstream));
    const events = parseSse(out);
    expect(events.at(-1)?.data).toBe("[DONE]");

    const textChunk = events.find((e) => {
      try {
        const d = JSON.parse(e.data);
        return d.choices?.[0]?.delta?.content === "X";
      } catch {
        return false;
      }
    });
    expect(textChunk).toBeTruthy();
  });

  test("ignores unknown event types without breaking the stream", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(sseChunk({ type: "response.created", response: {} }))
        );
        controller.enqueue(
          encoder.encode(
            sseChunk({ type: "response.in_progress", response: {} })
          )
        );
        controller.enqueue(
          encoder.encode(
            sseChunk({
              type: "response.output_text.delta",
              delta: "ok",
            })
          )
        );
        controller.enqueue(
          encoder.encode(
            sseChunk({ type: "response.completed", response: {} })
          )
        );
        controller.close();
      },
    });

    const out = await drainStream(translateResponsesSseToChatSse(upstream));
    const events = parseSse(out);
    expect(events.at(-1)?.data).toBe("[DONE]");
  });
});
