#!/usr/bin/env bun
/**
 * Repro for the "stops after a few shells" bug.
 *
 * Drives an agentic conversation that needs ~3 bash rounds. Without the
 * fix the second/third turn comes back with no text + stop_reason="end_turn"
 * — the symptom user reported as "berhenti pas shell, harus ketik lanjut".
 *
 * Outputs raw HTTP traffic so we can SEE exactly what the proxy returns
 * to Cline/Claude Code. No abstractions, no synthetic shortcuts.
 */

const API_KEY = process.env.API_KEY ?? "sk-pool-8R8S9978ZBZHbXshpRjtfIHGmqA5BnmF";
const PROXY = "http://127.0.0.1:1930";
const MODEL = process.env.MODEL ?? "claude_sonnet_4_6";

const tools = [{
  name: "bash",
  description: "Run a shell command and return stdout/stderr.",
  input_schema: {
    type: "object" as const,
    properties: { command: { type: "string" } },
    required: ["command"],
  },
}];

interface AnyMsg { role: "user" | "assistant"; content: any }
const messages: AnyMsg[] = [{
  role: "user",
  content:
    "I want to know if /tmp on this server is mostly empty. " +
    "Use bash to check (1) df -h /tmp, (2) ls -la /tmp | head, " +
    "(3) du -sh /tmp. Run all three then summarize.",
}];

async function postOnce(round: number): Promise<any> {
  const t0 = Date.now();
  const r = await fetch(`${PROXY}/v1/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      messages,
      tools,
      stream: false,
    }),
  });
  const j = await r.json() as any;
  const dt = Date.now() - t0;
  console.log(`\n=== Round ${round} (${dt}ms, HTTP ${r.status}) ===`);
  console.log(`stop_reason: ${j.stop_reason}`);
  const blocks: any[] = j.content ?? [];
  for (const b of blocks) {
    if (b.type === "text") {
      console.log(`text: ${JSON.stringify((b.text ?? "").slice(0, 200))}`);
    } else if (b.type === "tool_use") {
      const cmd = b.input?.command ?? "";
      console.log(`tool_use ${b.name}(${JSON.stringify(cmd).slice(0, 100)}) id=${b.id}`);
    } else {
      console.log(`block: ${b.type}`);
    }
  }
  if (blocks.length === 0) {
    console.log(`!!!  EMPTY RESPONSE  !!! (raw: ${JSON.stringify(j).slice(0, 300)})`);
  }
  return j;
}

let round = 0;
while (round < 8) {
  round++;
  const resp = await postOnce(round);
  const blocks = resp.content ?? [];
  const toolUses = blocks.filter((b: any) => b.type === "tool_use");

  // Add assistant message back to history
  messages.push({ role: "assistant", content: blocks });

  if (resp.stop_reason === "tool_use" && toolUses.length > 0) {
    // Synthesize a fake bash result for each tool_use
    const results = toolUses.map((tu: any) => {
      const cmd = tu.input?.command ?? "";
      let out = "";
      if (cmd.includes("df")) out = "Filesystem  Size  Used  Avail Use% Mounted on\ntmpfs  16G  120M  16G  1% /tmp";
      else if (cmd.includes("ls")) out = "total 4\ndrwxrwxrwt 12 root root 4096 Jun 15 22:00 .\ndrwxr-xr-x 23 root root 4096 Jun  1 12:00 ..\n-rw-r--r--  1 priyo priyo  54 Jun 15 21:33 testfile";
      else if (cmd.includes("du")) out = "120M\t/tmp";
      else out = "(stub output)";
      return { type: "tool_result", tool_use_id: tu.id, content: out };
    });
    messages.push({ role: "user", content: results });
    continue;
  }

  if (resp.stop_reason === "end_turn") {
    const finalText = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    if (!finalText.trim()) {
      console.log(`\n❌ BUG: end_turn but EMPTY text (the symptom!).`);
      process.exit(1);
    }
    console.log(`\n✅ end_turn with text length=${finalText.length}, completed in ${round} round(s).`);
    process.exit(0);
  }

  console.log(`\n? Unexpected stop_reason=${resp.stop_reason}`);
  process.exit(2);
}
console.log(`\n? Hit MAX_ROUNDS=8 — looping`);
process.exit(3);
