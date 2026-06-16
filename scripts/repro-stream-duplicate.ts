#!/usr/bin/env bun
/**
 * Reproduce the streaming-text-duplicate bug across multi-turn tool flow.
 * Streams 4 rounds (3 bash + 1 final summary), asserts no doubled text.
 */

const API_KEY = process.env.API_KEY ?? "sk-pool-8R8S9978ZBZHbXshpRjtfIHGmqA5BnmF";
const PROXY = process.env.PROXY ?? "http://127.0.0.1:1930";
const MODEL = process.env.MODEL ?? "claude_sonnet_4_6";

const tools = [{
  name: "bash",
  description: "Run a shell command",
  input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] },
}];

function stub(cmd: string): string {
  if (cmd.includes("df")) return "Filesystem Size Used Avail Use%\ntmpfs 16G 120M 16G 1%";
  if (cmd.includes("ls")) return "total 4\n-rw-r--r-- 1 priyo priyo 54 Jun 15 21:33 testfile";
  if (cmd.includes("du")) return "120M\t/tmp";
  return "(stub)";
}

interface ParsedTurn { rawDeltas: string[]; text: string; toolUses: any[]; stop: string | null; }

async function streamTurn(messages: any[]): Promise<ParsedTurn> {
  const body = { model: MODEL, max_tokens: 4096, messages, tools, stream: true };
  const resp = await fetch(`${PROXY}/v1/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "anthropic-version": "2023-06-01", "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
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
      if (ev === "content_block_start" && p.content_block?.type === "tool_use") curTU = { ...p.content_block, _input: "" };
      else if (ev === "content_block_delta") {
        if (p.delta?.type === "text_delta") { rawDeltas.push(p.delta.text); text += p.delta.text; }
        if (p.delta?.type === "input_json_delta" && curTU) curTU._input += p.delta.partial_json;
      } else if (ev === "content_block_stop" && curTU) {
        try { curTU.input = JSON.parse(curTU._input || "{}"); } catch { curTU.input = {}; }
        delete curTU._input; toolUses.push(curTU); curTU = null;
      } else if (ev === "message_delta" && p.delta?.stop_reason) stop = p.delta.stop_reason;
    }
  }
  return { rawDeltas, text, toolUses, stop };
}

// Doubling = same 30+ char substring appears twice within close proximity in the SAME turn's text.
function findInTurnDoubling(text: string): { sample: string; gap: number } | null {
  for (let len = 50; len >= 30; len -= 5) {
    for (let i = 0; i + len < text.length; i += 3) {
      const s = text.slice(i, i + len);
      if (/^\s*$/.test(s)) continue; // skip whitespace-only
      const j = text.indexOf(s, i + len);
      if (j > 0 && j - (i + len) < 200) {
        return { sample: s, gap: j - (i + len) };
      }
    }
  }
  return null;
}

const messages: any[] = [{
  role: "user",
  content: "Pakai bash tool. Jalankan: 1) df -h /tmp, 2) ls -la /tmp, 3) du -sh /tmp. Setelah 3 perintah, JELASKAN hasilnya dalam minimal 2 paragraf, dengan kata pembuka 'Berdasarkan hasil pemeriksaan ini' di paragraf pertama, dan kata pembuka 'Singkatnya' di paragraf kedua.",
}];

let round = 0;
while (round < 6) {
  round++;
  const turn = await streamTurn(messages);
  const finalText = turn.text.trim();
  console.log(`R${round}: ${turn.rawDeltas.length} deltas, ${turn.text.length} chars, ${turn.toolUses.length} tools, stop=${turn.stop}`);

  // Per-turn doubling check
  const dup = findInTurnDoubling(turn.text);
  if (dup) {
    console.log(`\n❌ R${round}: DOUBLE TEXT — 30+ chars repeat ${dup.gap} apart`);
    console.log(`   sample: ${JSON.stringify(dup.sample)}`);
    console.log(`\n   Last 60 raw deltas:`);
    turn.rawDeltas.slice(-60).forEach((d, i) => console.log(`     [${i}] ${JSON.stringify(d)}`));
    console.log(`\n   Full text:\n${turn.text}`);
    process.exit(1);
  }

  const blocks: any[] = [];
  if (turn.text) blocks.push({ type: "text", text: turn.text });
  for (const tu of turn.toolUses) blocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
  messages.push({ role: "assistant", content: blocks });

  if (turn.stop === "tool_use") {
    messages.push({ role: "user", content: turn.toolUses.map((tu) => ({ type: "tool_result", tool_use_id: tu.id, content: stub(tu.input?.command ?? "") })) });
    continue;
  }
  if (turn.stop === "end_turn") {
    console.log(`\n✅ Stream completed cleanly across ${round} round(s).`);
    if (finalText) console.log(`\nFinal text (${finalText.length} chars):\n${finalText.slice(0, 600)}${finalText.length > 600 ? "..." : ""}`);
    process.exit(0);
  }
  console.log(`? unexpected stop=${turn.stop}`); process.exit(2);
}
console.log("? max rounds"); process.exit(3);
