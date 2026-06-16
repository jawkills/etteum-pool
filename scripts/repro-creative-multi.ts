#!/usr/bin/env bun
/**
 * Reproduce closest to the user's screenshot: a multi-round creative task
 * with intentional natural-language flow that triggers text-before-tool
 * patterns, which is where the doubling appeared.
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

function stub(name: string): string {
  if (name === "Bash") return "(ok)";
  if (name === "Write") return "Wrote N lines";
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

function findInTurnDoubling(text: string): { sample: string; gap: number } | null {
  for (let len = 50; len >= 30; len -= 5) {
    for (let i = 0; i + len < text.length; i += 3) {
      const s = text.slice(i, i + len);
      if (/^\s*$/.test(s)) continue;
      const j = text.indexOf(s, i + len);
      if (j > 0 && j - (i + len) < 200) return { sample: s, gap: j - (i + len) };
    }
  }
  return null;
}

const messages: any[] = [{
  role: "user",
  content:
    "Buat landing page Sewa Mobil Keren di /tmp/sewa-mobil-test/, anggap dirimu senior UI/UX. " +
    "Pakai animasi yang menarik. Jangan tampak AI-generated. " +
    "Tahapan: 1) Jelaskan rencana singkat, lalu Bash mkdir, " +
    "lalu Write index.html sederhana (10-20 baris CSS inline), " +
    "lalu rangkum hasilnya.",
}];

let round = 0;
let allRoundsText = "";
while (round < 6) {
  round++;
  const turn = await streamTurn(messages);
  allRoundsText += `\n[R${round}]\n${turn.text}\n`;
  console.log(`R${round}: ${turn.rawDeltas.length} deltas, ${turn.text.length} chars, ${turn.toolUses.length} tools, stop=${turn.stop}`);

  const dup = findInTurnDoubling(turn.text);
  if (dup) {
    console.log(`\n❌ R${round}: DOUBLED TEXT — 30+ chars repeat ${dup.gap} apart`);
    console.log(`   sample: ${JSON.stringify(dup.sample)}`);
    console.log(`\n   Last 30 deltas:`);
    turn.rawDeltas.slice(-30).forEach((d, i) => console.log(`     [${i}] ${JSON.stringify(d)}`));
    console.log(`\n   Full text:\n${turn.text}`);
    process.exit(1);
  }

  const blocks: any[] = [];
  if (turn.text) blocks.push({ type: "text", text: turn.text });
  for (const tu of turn.toolUses) blocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
  messages.push({ role: "assistant", content: blocks });

  if (turn.stop === "tool_use") {
    messages.push({ role: "user", content: turn.toolUses.map((tu) => ({ type: "tool_result", tool_use_id: tu.id, content: stub(tu.name) })) });
    continue;
  }
  if (turn.stop === "end_turn") {
    console.log(`\n✅ Completed across ${round} round(s). All turns clean.`);
    process.exit(0);
  }
  console.log(`? unexpected stop=${turn.stop}`); process.exit(2);
}
console.log("? max rounds"); process.exit(3);
