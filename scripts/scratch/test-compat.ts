/**
 * Spec-compliance validator for Etteum Pool's
 *  - Anthropic Messages API  (/v1/messages)
 *  - OpenAI Chat Completions  (/v1/chat/completions)
 *
 * Reference (Anthropic SSE event types & order):
 *   message_start
 *   (content_block_start, [ping/content_block_delta]*, content_block_stop)*
 *   message_delta { delta.stop_reason, usage.output_tokens }
 *   message_stop
 *
 * Reference (OpenAI chunk):
 *   { id, object:"chat.completion.chunk", created, model, choices:[{index, delta, finish_reason}] }
 *   stream terminator: data: [DONE]
 */

const BASE = "http://localhost:1930";
const KEY = "pool-proxy-secret-key";

interface CheckResult { name: string; ok: boolean; detail?: string }
const results: CheckResult[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function readSSE(url: string, body: any): Promise<{ events: Array<{event: string, data: any, raw: string}>, status: number, headers: Headers }> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "authorization": `Bearer ${KEY}`, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ ...body, stream: true }),
  });
  const events: Array<{event: string, data: any, raw: string}> = [];
  if (!resp.body) return { events, status: resp.status, headers: resp.headers };
  const reader = resp.body.getReader();
  const td = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += td.decode(value, { stream: true });
    while (true) {
      const idx = buf.indexOf("\n\n");
      if (idx < 0) break;
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let event = "", data = "";
      for (const ln of chunk.split("\n")) {
        if (ln.startsWith("event: ")) event = ln.slice(7).trim();
        else if (ln.startsWith("data: ")) data = ln.slice(6);
      }
      if (!data) continue;
      let parsed: any = null;
      if (data === "[DONE]") parsed = "[DONE]";
      else { try { parsed = JSON.parse(data); } catch { parsed = { _raw: data }; } }
      events.push({ event, data: parsed, raw: chunk });
    }
  }
  return { events, status: resp.status, headers: resp.headers };
}

async function readJSON(url: string, body: any) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "authorization": `Bearer ${KEY}`, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data: any; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  return { status: resp.status, headers: resp.headers, data };
}

// ============================================================
// ANTHROPIC TESTS
// ============================================================

async function testAnthropicTextStream() {
  console.log("\n--- Anthropic /v1/messages: simple text stream ---");
  const { events, status, headers } = await readSSE(`${BASE}/v1/messages?beta=true`, {
    model: "claude_sonnet_4_6",
    max_tokens: 80,
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
  });
  check("Anthropic text: HTTP 200", status === 200, `got ${status}`);
  check("Anthropic text: Content-Type SSE", (headers.get("content-type") || "").includes("text/event-stream"));
  check("Anthropic text: got events", events.length > 0, `count=${events.length}`);

  const first = events[0];
  check("Anthropic text: first event = message_start", first?.event === "message_start", `got ${first?.event}`);
  check("Anthropic text: message_start.type", first?.data?.type === "message_start");
  const msg = first?.data?.message;
  check("Anthropic text: message_start.message.id starts msg_", typeof msg?.id === "string" && msg.id.startsWith("msg_"), `id=${msg?.id}`);
  check("Anthropic text: message_start.message.role=assistant", msg?.role === "assistant");
  check("Anthropic text: message_start.message.type=message", msg?.type === "message");
  check("Anthropic text: message_start.message.content=[]", Array.isArray(msg?.content) && msg.content.length === 0);
  check("Anthropic text: message_start.message.usage.input_tokens", typeof msg?.usage?.input_tokens === "number");

  const cbStart = events.find(e => e.event === "content_block_start");
  check("Anthropic text: content_block_start present", !!cbStart);
  check("Anthropic text: content_block_start has index", typeof cbStart?.data?.index === "number");
  check("Anthropic text: content_block_start.content_block.type=text", cbStart?.data?.content_block?.type === "text");

  const deltas = events.filter(e => e.event === "content_block_delta" && e.data?.delta?.type === "text_delta");
  check("Anthropic text: text_delta events present", deltas.length > 0, `count=${deltas.length}`);
  const textConcat = deltas.map(d => d.data.delta.text).join("");
  check("Anthropic text: deltas yield non-empty text", textConcat.length > 0, `text=${JSON.stringify(textConcat).slice(0,60)}`);

  const cbStop = events.find(e => e.event === "content_block_stop");
  check("Anthropic text: content_block_stop present", !!cbStop);

  const msgDelta = events.find(e => e.event === "message_delta");
  check("Anthropic text: message_delta present", !!msgDelta);
  check("Anthropic text: message_delta.delta.stop_reason set", typeof msgDelta?.data?.delta?.stop_reason === "string", `stop_reason=${msgDelta?.data?.delta?.stop_reason}`);
  check("Anthropic text: message_delta.usage.output_tokens", typeof msgDelta?.data?.usage?.output_tokens === "number");

  const msgStop = events.find(e => e.event === "message_stop");
  check("Anthropic text: message_stop present", !!msgStop);
  check("Anthropic text: message_stop is LAST event", events[events.length - 1]?.event === "message_stop");
}

async function testAnthropicNonStream() {
  console.log("\n--- Anthropic /v1/messages: non-streaming ---");
  const { status, data } = await readJSON(`${BASE}/v1/messages?beta=true`, {
    model: "claude_sonnet_4_6",
    max_tokens: 60,
    stream: false,
    messages: [{ role: "user", content: "Reply with the single word: pong" }],
  });
  check("Anthropic non-stream: HTTP 200", status === 200, `got ${status}`);
  check("Anthropic non-stream: id starts msg_", typeof data?.id === "string" && data.id.startsWith("msg_"));
  check("Anthropic non-stream: type=message", data?.type === "message");
  check("Anthropic non-stream: role=assistant", data?.role === "assistant");
  check("Anthropic non-stream: content is array", Array.isArray(data?.content));
  check("Anthropic non-stream: content[0].type=text", data?.content?.[0]?.type === "text");
  check("Anthropic non-stream: content text non-empty", typeof data?.content?.[0]?.text === "string" && data.content[0].text.length > 0);
  check("Anthropic non-stream: stop_reason set", typeof data?.stop_reason === "string");
  check("Anthropic non-stream: usage.input_tokens", typeof data?.usage?.input_tokens === "number");
  check("Anthropic non-stream: usage.output_tokens", typeof data?.usage?.output_tokens === "number");
}

async function testAnthropicToolStream() {
  console.log("\n--- Anthropic /v1/messages: tool_use streaming ---");
  const { status, events } = await readSSE(`${BASE}/v1/messages?beta=true`, {
    model: "qd-Auto",
    max_tokens: 200,
    tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: { location: { type: "string" } }, required: ["location"] } }],
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: "What's the weather in Paris? Use the get_weather tool now." }],
  });
  check("Anthropic tool: HTTP 200", status === 200);
  const toolStart = events.find(e => e.event === "content_block_start" && e.data?.content_block?.type === "tool_use");
  check("Anthropic tool: tool_use content_block_start emitted", !!toolStart);
  if (toolStart) {
    const cb = toolStart.data.content_block;
    check("Anthropic tool: tool_use.id present", typeof cb?.id === "string" && cb.id.length > 0, `id=${cb?.id}`);
    check("Anthropic tool: tool_use.name=get_weather", cb?.name === "get_weather");
    check("Anthropic tool: tool_use.input is object", typeof cb?.input === "object" && cb?.input !== null);
  }
  const inpDeltas = events.filter(e => e.event === "content_block_delta" && e.data?.delta?.type === "input_json_delta");
  check("Anthropic tool: input_json_delta deltas emitted", inpDeltas.length > 0, `count=${inpDeltas.length}`);
  const concat = inpDeltas.map(d => d.data.delta.partial_json).join("");
  let parsedInput: any = null;
  try { parsedInput = JSON.parse(concat); } catch {}
  check("Anthropic tool: concatenated input_json_delta is valid JSON", parsedInput !== null, `concat=${concat.slice(0,80)}`);
  check("Anthropic tool: input contains location field", parsedInput && typeof parsedInput.location === "string", `loc=${parsedInput?.location}`);
  const msgDelta = events.find(e => e.event === "message_delta");
  check("Anthropic tool: message_delta.stop_reason=tool_use", msgDelta?.data?.delta?.stop_reason === "tool_use", `got ${msgDelta?.data?.delta?.stop_reason}`);
}

// ============================================================
// OPENAI TESTS
// ============================================================

async function testOpenAITextStream() {
  console.log("\n--- OpenAI /v1/chat/completions: simple text stream ---");
  const { events, status, headers } = await readSSE(`${BASE}/v1/chat/completions`, {
    model: "claude_sonnet_4_6",
    max_tokens: 60,
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
  });
  check("OpenAI text: HTTP 200", status === 200, `got ${status}`);
  check("OpenAI text: Content-Type SSE", (headers.get("content-type") || "").includes("text/event-stream"));
  check("OpenAI text: got chunks", events.length > 0, `count=${events.length}`);
  // Last event MUST be [DONE]
  const last = events[events.length - 1];
  check("OpenAI text: terminator data:[DONE]", last?.data === "[DONE]", `last=${JSON.stringify(last?.data).slice(0,60)}`);

  // First non-DONE chunk
  const first = events.find(e => e.data !== "[DONE]");
  check("OpenAI text: first chunk has id", typeof first?.data?.id === "string", `id=${first?.data?.id}`);
  check("OpenAI text: object='chat.completion.chunk'", first?.data?.object === "chat.completion.chunk", `object=${first?.data?.object}`);
  check("OpenAI text: choices[0].delta exists", first?.data?.choices?.[0] && typeof first.data.choices[0].delta === "object");

  // Aggregate content
  let content = "";
  for (const e of events) {
    if (e.data === "[DONE]") continue;
    const d = e.data?.choices?.[0]?.delta;
    if (d?.content) content += d.content;
  }
  check("OpenAI text: aggregated content non-empty", content.length > 0, `content=${JSON.stringify(content).slice(0,60)}`);

  // finish_reason in some chunk
  let finishSeen: any = null;
  for (const e of events) {
    if (e.data === "[DONE]") continue;
    const fr = e.data?.choices?.[0]?.finish_reason;
    if (fr) finishSeen = fr;
  }
  check("OpenAI text: finish_reason emitted (stop)", finishSeen !== null && finishSeen !== undefined, `finish=${finishSeen}`);
}

async function testOpenAINonStream() {
  console.log("\n--- OpenAI /v1/chat/completions: non-streaming ---");
  const { status, data } = await readJSON(`${BASE}/v1/chat/completions`, {
    model: "claude_sonnet_4_6",
    max_tokens: 60,
    stream: false,
    messages: [{ role: "user", content: "Reply with the single word: pong" }],
  });
  check("OpenAI non-stream: HTTP 200", status === 200, `got ${status}`);
  check("OpenAI non-stream: object='chat.completion'", data?.object === "chat.completion", `object=${data?.object}`);
  check("OpenAI non-stream: id present", typeof data?.id === "string");
  check("OpenAI non-stream: choices[0].message", data?.choices?.[0]?.message != null);
  check("OpenAI non-stream: choices[0].message.role=assistant", data?.choices?.[0]?.message?.role === "assistant");
  check("OpenAI non-stream: content non-empty", typeof data?.choices?.[0]?.message?.content === "string" && data.choices[0].message.content.length > 0);
  check("OpenAI non-stream: finish_reason set", typeof data?.choices?.[0]?.finish_reason === "string", `finish=${data?.choices?.[0]?.finish_reason}`);
  check("OpenAI non-stream: usage.prompt_tokens", typeof data?.usage?.prompt_tokens === "number");
  check("OpenAI non-stream: usage.completion_tokens", typeof data?.usage?.completion_tokens === "number");
  check("OpenAI non-stream: usage.total_tokens", typeof data?.usage?.total_tokens === "number");
}

async function testOpenAIToolStream() {
  console.log("\n--- OpenAI /v1/chat/completions: tool_calls streaming ---");
  const { status, events } = await readSSE(`${BASE}/v1/chat/completions`, {
    model: "qd-Auto",
    max_tokens: 200,
    tools: [{ type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] } } }],
    tool_choice: "required",
    messages: [{ role: "user", content: "What's the weather in Paris? Use get_weather." }],
  });
  check("OpenAI tool: HTTP 200", status === 200);
  // Find first tool_calls delta
  let firstToolCall: any = null;
  let argsConcat = "";
  let finishReason: string | null = null;
  for (const e of events) {
    if (e.data === "[DONE]") continue;
    const d = e.data?.choices?.[0]?.delta;
    if (d?.tool_calls) {
      for (const tc of d.tool_calls) {
        if (!firstToolCall && (tc.id || tc.function?.name)) firstToolCall = tc;
        if (tc.function?.arguments) argsConcat += tc.function.arguments;
      }
    }
    const fr = e.data?.choices?.[0]?.finish_reason;
    if (fr) finishReason = fr;
  }
  check("OpenAI tool: at least one tool_calls delta", firstToolCall !== null);
  if (firstToolCall) {
    check("OpenAI tool: tool_call has id", typeof firstToolCall.id === "string");
    check("OpenAI tool: tool_call.type=function (or absent)", !firstToolCall.type || firstToolCall.type === "function");
    check("OpenAI tool: tool_call.function.name=get_weather", firstToolCall.function?.name === "get_weather", `name=${firstToolCall.function?.name}`);
  }
  let parsedArgs: any = null;
  try { parsedArgs = JSON.parse(argsConcat); } catch {}
  check("OpenAI tool: aggregated arguments are valid JSON", parsedArgs !== null, `args=${argsConcat.slice(0,80)}`);
  check("OpenAI tool: arguments include location", parsedArgs && typeof parsedArgs.location === "string", `loc=${parsedArgs?.location}`);
  check("OpenAI tool: finish_reason='tool_calls'", finishReason === "tool_calls", `got ${finishReason}`);
}

async function testCrossModelOpenAI() {
  console.log("\n--- OpenAI /v1/chat/completions: cross-model (non-duo provider) ---");
  // Try first available non-gitlab-duo openai-compatible model (gpt-* style)
  const acc: any = await fetch(`${BASE}/v1/models`, { headers: { "authorization": `Bearer ${KEY}` } }).then(r => r.json()).catch(() => null);
  const arr = acc?.data || acc || [];
  const candidate = (Array.isArray(arr) ? arr : []).find((m: any) =>
    (m.owned_by !== "gitlab-duo") && /sonnet|haiku|opus|gpt-|claude-/i.test(m.id || ""));
  if (!candidate) {
    check("OpenAI cross-model: candidate model exists", false, "no non-duo model found");
    return;
  }
  const { status, events } = await readSSE(`${BASE}/v1/chat/completions`, {
    model: candidate.id,
    max_tokens: 40,
    messages: [{ role: "user", content: "Reply: ok" }],
  });
  check(`OpenAI cross-model (${candidate.id}): HTTP 200`, status === 200, `got ${status}`);
  const last = events[events.length - 1];
  check(`OpenAI cross-model (${candidate.id}): terminator [DONE]`, last?.data === "[DONE]");
}

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Anthropic + OpenAI Compatibility Validator");
  console.log("═══════════════════════════════════════════════");

  await testAnthropicTextStream();
  await testAnthropicNonStream();
  await testAnthropicToolStream();
  await testOpenAITextStream();
  await testOpenAINonStream();
  await testOpenAIToolStream();
  await testCrossModelOpenAI();

  console.log("\n═══════════════════════════════════════════════");
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  console.log(`SUMMARY: ${passed}/${results.length} passed`);
  if (failed.length > 0) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    process.exit(1);
  }
  console.log("All compliance checks passed ✅");
}

main().catch(e => { console.error("crash", e); process.exit(2); });
