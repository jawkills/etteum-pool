#!/usr/bin/env bun
/**
 * Thorough end-to-end test of GitLab Duo provider via the proxy.
 *
 *   1. Anthropic /v1/messages NON-stream — multi-turn agentic with bash.
 *   2. Anthropic /v1/messages STREAM — same flow but SSE.
 *   3. OpenAI /v1/chat/completions NON-stream — bash via tools[].
 *   4. OpenAI /v1/chat/completions STREAM — same.
 *
 * Each scenario asserts:
 *   - All HTTP calls return 200.
 *   - Final assistant message has non-empty text.
 *   - No "WS closed empty" or "[gitlab-duo error]" leakage in the text.
 *   - The model used the bash tool at least once.
 *
 * Designed to catch the "berhenti pas shell, harus ketik lanjut" symptom:
 *   if any continuation turn comes back with empty text (the bug we're
 *   fixing), the test fails LOUDLY with the round number and HTTP body.
 */

const API_KEY = process.env.API_KEY ?? "sk-pool-8R8S9978ZBZHbXshpRjtfIHGmqA5BnmF";
const PROXY = process.env.PROXY ?? "http://127.0.0.1:1930";
const MODEL = process.env.MODEL ?? "claude_sonnet_4_6";
const MAX_ROUNDS = 8;

interface ScenarioResult {
  name: string;
  passed: boolean;
  rounds: number;
  toolCalls: number;
  detail: string;
}
const results: ScenarioResult[] = [];

function logStep(s: string): void { console.log(`\n>>> ${s}`); }
function fakeBashStub(cmd: string): string {
  if (cmd.includes("df")) return "Filesystem  Size  Used  Avail Use%\ntmpfs  16G  120M  16G  1%";
  if (cmd.includes("ls")) return "total 4\n-rw-r--r-- 1 priyo priyo 54 Jun 15 21:33 testfile";
  if (cmd.includes("du")) return "120M\t/tmp";
  if (cmd.includes("uname")) return "Linux poolprox 6.5.0";
  if (cmd.includes("free")) return "total used free\nMem: 16G 4G 12G";
  if (cmd.includes("uptime")) return "21:30 up 6 days, 2:15";
  return "(stub output)";
}
function looksLikeError(text: string): string | null {
  if (/\[gitlab-duo error\]/i.test(text)) return "contains '[gitlab-duo error]'";
  if (/WS closed empty/i.test(text)) return "contains 'WS closed empty'";
  return null;
}

// ─── Scenario 1: Anthropic non-stream ────────────────────────────────────
async function anthropicNonStream(): Promise<ScenarioResult> {
  const name = "Anthropic /v1/messages (non-stream)";
  logStep(name);
  const tools = [{
    name: "bash",
    description: "Run a shell command",
    input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] },
  }];
  const messages: any[] = [{
    role: "user",
    content: "Use the bash tool. Run df -h /tmp, then ls /tmp, then du -sh /tmp. Then summarize. You MUST use the bash tool — don't just describe what would happen.",
  }];
  let toolCalls = 0;
  for (let r = 1; r <= MAX_ROUNDS; r++) {
    const body = { model: MODEL, max_tokens: 4096, messages, tools, stream: false };
    const resp = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (resp.status !== 200) return { name, passed: false, rounds: r, toolCalls, detail: `round ${r} HTTP ${resp.status}` };
    const j: any = await resp.json();
    const blocks: any[] = j.content ?? [];
    messages.push({ role: "assistant", content: blocks });
    const tu = blocks.filter((b) => b.type === "tool_use");
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
    const errHit = looksLikeError(text);
    if (errHit) return { name, passed: false, rounds: r, toolCalls, detail: `round ${r}: ${errHit}` };
    if (j.stop_reason === "tool_use" && tu.length) {
      toolCalls += tu.length;
      console.log(`  round ${r}: ${tu.length} tool_use(s) [${tu.map((t: any) => t.input?.command?.slice(0, 40)).join(", ")}]`);
      messages.push({ role: "user", content: tu.map((t: any) => ({ type: "tool_result", tool_use_id: t.id, content: fakeBashStub(t.input?.command ?? "") })) });
      continue;
    }
    if (j.stop_reason === "end_turn") {
      if (!text.trim()) return { name, passed: false, rounds: r, toolCalls, detail: `round ${r}: end_turn EMPTY TEXT (BUG)` };
      console.log(`  round ${r}: end_turn, text length=${text.length}`);
      return { name, passed: toolCalls > 0, rounds: r, toolCalls, detail: text.slice(0, 100) };
    }
    return { name, passed: false, rounds: r, toolCalls, detail: `unexpected stop_reason=${j.stop_reason}` };
  }
  return { name, passed: false, rounds: MAX_ROUNDS, toolCalls, detail: "exceeded MAX_ROUNDS" };
}

// ─── Scenario 2: Anthropic stream ─────────────────────────────────────────
async function anthropicStream(): Promise<ScenarioResult> {
  const name = "Anthropic /v1/messages (stream)";
  logStep(name);
  const tools = [{ name: "bash", description: "Run a shell command", input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } }];
  const messages: any[] = [{ role: "user", content: "Run uname -a, then free -h, then say done. Use bash." }];
  let toolCalls = 0;
  for (let r = 1; r <= MAX_ROUNDS; r++) {
    const body = { model: MODEL, max_tokens: 4096, messages, tools, stream: true };
    const resp = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "anthropic-version": "2023-06-01", "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
    if (resp.status !== 200) return { name, passed: false, rounds: r, toolCalls, detail: `round ${r} HTTP ${resp.status}` };
    if (!resp.body) return { name, passed: false, rounds: r, toolCalls, detail: "no body" };
    // Parse SSE frames
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const blocks: any[] = []; // reconstructed content blocks
    let stopReason: string | null = null;
    let textAcc = "";
    let curToolUse: any = null;
    let curText = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = frame.split("\n").find((l) => l.startsWith("event: "))?.slice(7);
        const data = frame.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
        if (!ev || !data) continue;
        let payload: any; try { payload = JSON.parse(data); } catch { continue; }
        if (ev === "content_block_start") {
          if (payload.content_block?.type === "tool_use") {
            curToolUse = { ...payload.content_block, input: {} };
          } else if (payload.content_block?.type === "text") {
            curText = true;
          }
        } else if (ev === "content_block_delta") {
          if (payload.delta?.type === "text_delta") textAcc += payload.delta.text;
          if (payload.delta?.type === "input_json_delta" && curToolUse) curToolUse._input = (curToolUse._input ?? "") + payload.delta.partial_json;
        } else if (ev === "content_block_stop") {
          if (curToolUse) {
            try { curToolUse.input = JSON.parse(curToolUse._input ?? "{}"); } catch { curToolUse.input = {}; }
            delete curToolUse._input;
            blocks.push(curToolUse);
            curToolUse = null;
          } else if (curText) {
            blocks.push({ type: "text", text: textAcc });
            textAcc = "";
            curText = false;
          }
        } else if (ev === "message_delta") {
          if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason;
        }
      }
    }
    const errHit = looksLikeError(blocks.filter((b) => b.type === "text").map((b) => b.text).join(""));
    if (errHit) return { name, passed: false, rounds: r, toolCalls, detail: `round ${r}: ${errHit}` };
    messages.push({ role: "assistant", content: blocks });
    const tu = blocks.filter((b) => b.type === "tool_use");
    if (stopReason === "tool_use" && tu.length) {
      toolCalls += tu.length;
      console.log(`  round ${r}: stream ${tu.length} tool_use(s) [${tu.map((t) => t.input?.command?.slice(0, 30)).join(", ")}]`);
      messages.push({ role: "user", content: tu.map((t) => ({ type: "tool_result", tool_use_id: t.id, content: fakeBashStub(t.input?.command ?? "") })) });
      continue;
    }
    if (stopReason === "end_turn") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (!text.trim()) return { name, passed: false, rounds: r, toolCalls, detail: `round ${r}: end_turn EMPTY TEXT (BUG)` };
      console.log(`  round ${r}: end_turn, text length=${text.length}`);
      return { name, passed: toolCalls > 0, rounds: r, toolCalls, detail: text.slice(0, 100) };
    }
    return { name, passed: false, rounds: r, toolCalls, detail: `unexpected stop_reason=${stopReason}` };
  }
  return { name, passed: false, rounds: MAX_ROUNDS, toolCalls, detail: "exceeded MAX_ROUNDS" };
}

// ─── Scenario 3: OpenAI non-stream ────────────────────────────────────────
async function openaiNonStream(): Promise<ScenarioResult> {
  const name = "OpenAI /v1/chat/completions (non-stream)";
  logStep(name);
  const tools = [{
    type: "function" as const,
    function: { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  }];
  const messages: any[] = [{ role: "user", content: "Run uptime then say what time the server has been up." }];
  let toolCalls = 0;
  for (let r = 1; r <= MAX_ROUNDS; r++) {
    const body = { model: MODEL, messages, tools, max_tokens: 4096, stream: false };
    const resp = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (resp.status !== 200) return { name, passed: false, rounds: r, toolCalls, detail: `round ${r} HTTP ${resp.status}` };
    const j: any = await resp.json();
    const choice = j.choices?.[0];
    const msg = choice?.message;
    messages.push(msg);
    const finish = choice?.finish_reason;
    const text: string = msg?.content ?? "";
    const errHit = looksLikeError(text);
    if (errHit) return { name, passed: false, rounds: r, toolCalls, detail: `round ${r}: ${errHit}` };
    const tcs = msg?.tool_calls ?? [];
    if (finish === "tool_calls" && tcs.length) {
      toolCalls += tcs.length;
      console.log(`  round ${r}: ${tcs.length} tool_call(s)`);
      for (const tc of tcs) {
        let args: any = {}; try { args = JSON.parse(tc.function.arguments); } catch { /* */ }
        messages.push({ role: "tool", tool_call_id: tc.id, content: fakeBashStub(args.command ?? "") });
      }
      continue;
    }
    if (finish === "stop") {
      if (!text.trim()) return { name, passed: false, rounds: r, toolCalls, detail: `round ${r}: stop EMPTY TEXT (BUG)` };
      console.log(`  round ${r}: stop, text length=${text.length}`);
      return { name, passed: toolCalls > 0, rounds: r, toolCalls, detail: text.slice(0, 100) };
    }
    return { name, passed: false, rounds: r, toolCalls, detail: `unexpected finish_reason=${finish}` };
  }
  return { name, passed: false, rounds: MAX_ROUNDS, toolCalls, detail: "exceeded MAX_ROUNDS" };
}

// ─── Scenario 4: OpenAI stream ────────────────────────────────────────────
async function openaiStream(): Promise<ScenarioResult> {
  const name = "OpenAI /v1/chat/completions (stream)";
  logStep(name);
  const tools = [{ type: "function" as const, function: { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }];
  const messages: any[] = [{ role: "user", content: "Run uname then df, then summarize." }];
  let toolCalls = 0;
  for (let r = 1; r <= MAX_ROUNDS; r++) {
    const body = { model: MODEL, messages, tools, max_tokens: 4096, stream: true };
    const resp = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
    if (resp.status !== 200) return { name, passed: false, rounds: r, toolCalls, detail: `round ${r} HTTP ${resp.status}` };
    if (!resp.body) return { name, passed: false, rounds: r, toolCalls, detail: "no body" };
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const accText: string[] = [];
    const tcMap: Record<number, { id: string; name: string; argsStr: string }> = {};
    let finish: string | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dline = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dline) continue;
        const data = dline.slice(6);
        if (data === "[DONE]") continue;
        let p: any; try { p = JSON.parse(data); } catch { continue; }
        const delta = p.choices?.[0]?.delta;
        if (delta?.content) accText.push(delta.content);
        if (delta?.tool_calls) {
          for (const dt of delta.tool_calls) {
            const idx2 = dt.index ?? 0;
            if (!tcMap[idx2]) tcMap[idx2] = { id: dt.id ?? "", name: dt.function?.name ?? "", argsStr: "" };
            if (dt.id) tcMap[idx2].id = dt.id;
            if (dt.function?.name) tcMap[idx2].name = dt.function.name;
            if (dt.function?.arguments) tcMap[idx2].argsStr += dt.function.arguments;
          }
        }
        if (p.choices?.[0]?.finish_reason) finish = p.choices[0].finish_reason;
      }
    }
    const fullText = accText.join("");
    const errHit = looksLikeError(fullText);
    if (errHit) return { name, passed: false, rounds: r, toolCalls, detail: `round ${r}: ${errHit}` };
    const tcs = Object.values(tcMap);
    const assistantMsg: any = { role: "assistant", content: fullText || null };
    if (tcs.length) assistantMsg.tool_calls = tcs.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.argsStr } }));
    messages.push(assistantMsg);
    if (finish === "tool_calls" && tcs.length) {
      toolCalls += tcs.length;
      console.log(`  round ${r}: stream ${tcs.length} tool_call(s)`);
      for (const tc of tcs) {
        let args: any = {}; try { args = JSON.parse(tc.argsStr); } catch { /* */ }
        messages.push({ role: "tool", tool_call_id: tc.id, content: fakeBashStub(args.command ?? "") });
      }
      continue;
    }
    if (finish === "stop") {
      if (!fullText.trim()) return { name, passed: false, rounds: r, toolCalls, detail: `round ${r}: stop EMPTY TEXT (BUG)` };
      console.log(`  round ${r}: stop, text length=${fullText.length}`);
      return { name, passed: toolCalls > 0, rounds: r, toolCalls, detail: fullText.slice(0, 100) };
    }
    return { name, passed: false, rounds: r, toolCalls, detail: `unexpected finish_reason=${finish}` };
  }
  return { name, passed: false, rounds: MAX_ROUNDS, toolCalls, detail: "exceeded MAX_ROUNDS" };
}

// ─── Run all ──────────────────────────────────────────────────────────────
results.push(await anthropicNonStream());
results.push(await anthropicStream());
results.push(await openaiNonStream());
results.push(await openaiStream());

console.log("\n────────────────────────────────────────────────────────────");
console.log("SUMMARY");
console.log("────────────────────────────────────────────────────────────");
let allPass = true;
for (const r of results) {
  const tag = r.passed ? "✅ PASS" : "❌ FAIL";
  console.log(`${tag}  ${r.name}  rounds=${r.rounds}  tools=${r.toolCalls}`);
  if (!r.passed) console.log(`    ${r.detail}`);
  if (!r.passed) allPass = false;
}
console.log("────────────────────────────────────────────────────────────");
process.exit(allPass ? 0 : 1);
