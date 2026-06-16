#!/usr/bin/env bun
/**
 * Reproduce the user's "double text in chat" scenario by driving a
 * creative streaming task (matches the screenshot pattern).
 *
 * The original symptom: same paragraph appears twice as separate chat
 * bubbles — once via streaming deltas, once via the end-of-turn safety
 * net that fell back to "emit full content" on prefix divergence.
 *
 * We assert: NO substring of 40+ chars appears twice in the streamed
 * text, AND the safety-net never re-emits the whole answer.
 */

const API_KEY = process.env.API_KEY ?? "sk-pool-8R8S9978ZBZHbXshpRjtfIHGmqA5BnmF";
const PROXY = process.env.PROXY ?? "http://127.0.0.1:1930";
const MODEL = process.env.MODEL ?? "claude_sonnet_4_6";

const tools = [{
  name: "Bash",
  description: "Run a shell command",
  input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] },
}, {
  name: "Write",
  description: "Write a file",
  input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] },
}];

function stub(toolName: string, _input: any): string {
  if (toolName === "Bash") return "(stub bash output)";
  if (toolName === "Write") return "Wrote 100 lines";
  return "(stub)";
}

interface ParsedTurn {
  rawDeltas: string[];
  text: string;
  toolUses: any[];
  stop: string | null;
}

async function streamTurn(messages: any[]): Promise<ParsedTurn> {
  const body = { model: MODEL, max_tokens: 4096, messages, tools, stream: true };
  const resp = await fetch(`${PROXY}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });
  if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
  const reader = resp.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const rawDeltas: string[] = [];
  let text = "";
  let curTU: any = null;
  const toolUses: any[] = [];
  let stop: string | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const f = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const ev = f.split("\n").find((l) => l.startsWith("event: "))?.slice(7);
      const data = f.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
      if (!ev || !data) continue;
      let p: any; try { p = JSON.parse(data); } catch { continue; }
      if (ev === "content_block_start") {
        if (p.content_block?.type === "tool_use") curTU = { ...p.content_block, _input: "" };
      } else if (ev === "content_block_delta") {
        if (p.delta?.type === "text_delta") { rawDeltas.push(p.delta.text); text += p.delta.text; }
        if (p.delta?.type === "input_json_delta" && curTU) curTU._input += p.delta.partial_json;
      } else if (ev === "content_block_stop") {
        if (curTU) {
          try { curTU.input = JSON.parse(curTU._input || "{}"); } catch { curTU.input = {}; }
          delete curTU._input; toolUses.push(curTU); curTU = null;
        }
      } else if (ev === "message_delta") {
        if (p.delta?.stop_reason) stop = p.delta.stop_reason;
      }
    }
  }
  return { rawDeltas, text, toolUses, stop };
}

// Detect TRANSPORT-level doubling: the proxy re-emitting a block of text it
// already streamed. This is the real bug (the end-of-turn safety net falling
// back to "emit full content", producing a duplicate chat bubble).
//
// We deliberately do NOT flag natural phrase repetition by the model itself
// (e.g. it keeps saying "landing page modern dengan desain premium" as a
// stylistic tic). Earlier this detector matched any 40+ char substring that
// recurred, which false-positived on such tics. The transport bug has a
// distinct signature: a LONG, CONTIGUOUS run (a whole paragraph/answer) is
// repeated verbatim — far longer than any natural phrase.
//
// Signature we look for: the longest verbatim repeated block. If a contiguous
// run of ≥ MIN_DUP_RUN chars appears twice, that is the safety-net re-emit,
// not a stylistic phrase.
const MIN_DUP_RUN = 200;

function findDoubling(text: string): { sample: string; gap: number; runLen: number } | null {
  // Slide a window and, for each start, greedily extend the longest match that
  // occurs again later in the text. Report only runs ≥ MIN_DUP_RUN, which a
  // natural phrase will never reach but a re-emitted paragraph always will.
  for (let i = 0; i + MIN_DUP_RUN < text.length; i += 20) {
    const seed = text.slice(i, i + 40);
    let j = text.indexOf(seed, i + 40);
    while (j > 0) {
      // Extend the match as far as it stays verbatim.
      let runLen = 40;
      while (
        i + runLen < j &&
        j + runLen < text.length &&
        text[i + runLen] === text[j + runLen]
      ) {
        runLen++;
      }
      if (runLen >= MIN_DUP_RUN) {
        return { sample: text.slice(i, i + 80), gap: j - (i + runLen), runLen };
      }
      j = text.indexOf(seed, j + 1);
    }
  }
  return null;
}

const messages: any[] = [{
  role: "user",
  content:
    "Aku mau buat landing page sederhana. Tolong: " +
    "1) Jelaskan dulu rencanamu dalam 2 paragraf. " +
    "2) Lalu jalankan bash 'mkdir -p /tmp/lp-test'. " +
    "3) Lalu jelaskan apa yang akan kamu lakukan selanjutnya dalam 2 paragraf, " +
    "    pakai kata-kata yang mirip-mirip dengan paragraf sebelumnya. " +
    "4) Lalu Write file '/tmp/lp-test/index.html' dengan HTML sederhana. " +
    "5) Lalu rangkum hasilnya. " +
    "PENTING: di setiap paragraf, sebut frasa 'landing page modern dengan desain premium' minimal sekali.",
}];

let allText = "";
let round = 0;
while (round < 8) {
  round++;
  const t0 = Date.now();
  const turn = await streamTurn(messages);
  console.log(`R${round} (${Date.now() - t0}ms): ${turn.rawDeltas.length} deltas, ${turn.text.length} chars, ${turn.toolUses.length} tools, stop=${turn.stop}`);
  allText += turn.text + "\n----\n";

  // Per-turn doubling check
  const dup = findDoubling(turn.text);
  if (dup) {
    console.log(`\n❌ R${round}: TRANSPORT DOUBLE TEXT (verbatim run of ${dup.runLen} chars repeats ${dup.gap} chars apart):`);
    console.log(`   "${dup.sample}..."`);
    console.log(`\n   First 30 raw deltas:`);
    turn.rawDeltas.slice(0, 30).forEach((d, i) => console.log(`     [${i}] ${JSON.stringify(d)}`));
    console.log(`\n   Full turn text (${turn.text.length} chars):\n${turn.text}`);
    process.exit(1);
  }

  // Build assistant message
  const blocks: any[] = [];
  if (turn.text) blocks.push({ type: "text", text: turn.text });
  for (const tu of turn.toolUses) blocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
  messages.push({ role: "assistant", content: blocks });

  if (turn.stop === "tool_use") {
    const results = turn.toolUses.map((tu) => ({
      type: "tool_result", tool_use_id: tu.id, content: stub(tu.name, tu.input),
    }));
    messages.push({ role: "user", content: results });
    continue;
  }
  if (turn.stop === "end_turn") {
    // Cross-turn check uses the same transport signature (≥ MIN_DUP_RUN verbatim
    // run). The "\n----\n" separators we insert between turns prevent a single
    // run from spanning two distinct turns by accident, so a hit here means the
    // SAME answer was streamed twice — the screenshot's bug.
    const dupAll = findDoubling(allText);
    if (dupAll) {
      console.log(`\n❌ Cross-turn TRANSPORT doubling (verbatim run of ${dupAll.runLen} chars): "${dupAll.sample}..."`);
      console.log(`\nAll text:\n${allText}`);
      process.exit(1);
    }
    console.log(`\n✅ Stream completed cleanly across ${round} round(s). No intra-turn doubling.`);
    process.exit(0);
  }
  console.log(`? unexpected stop=${turn.stop}`);
  process.exit(2);
}
console.log("? max rounds");
process.exit(3);
