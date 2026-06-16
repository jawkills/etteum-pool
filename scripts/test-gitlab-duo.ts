#!/usr/bin/env bun
/**
 * GitLab Duo provider — end-to-end smoke test.
 *
 * Drives an agentic, multi-turn conversation through the running etteum proxy:
 *   1. Verify (or register) a `gitlab-duo` account from a PAT.
 *   2. POST /v1/messages with a `bash` and `read_file` tool declared.
 *   3. Loop until the workflow completes — auto-respond to any tool_use rounds
 *      with synthetic tool_result content so the model can keep going.
 *   4. Print pass/fail with the failing turn number on failure.
 *
 * Usage:
 *   GITLAB_DUO_PAT=<pat> bun scripts/test-gitlab-duo.ts
 *   bun scripts/test-gitlab-duo.ts --pat <pat>
 *                                   [--base-url https://gitlab.com]
 *                                   [--model claude_sonnet_4_6]
 *                                   [--port 1930]
 *
 * Falls back to ~/.gitlab/storage.json (the duo CLI's storage) if --pat / env
 * isn't set.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Args ─────────────────────────────────────────────────────────────────

const args = Bun.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

let pat = flag("--pat") ?? process.env.GITLAB_DUO_PAT ?? "";
let baseUrl = flag("--base-url") ?? process.env.GITLAB_URL ?? "";
const model = flag("--model") ?? process.env.GITLAB_DUO_MODEL ?? "claude_sonnet_4_6";
const port = flag("--port") ?? process.env.ETTEUM_PORT ?? "1930";
const apiKey = process.env.ETTEUM_API_KEY ?? process.env.API_KEY ?? "pool-proxy-secret-key";
const proxyUrl = `http://127.0.0.1:${port}`;

if (!pat || !baseUrl) {
  try {
    const storage = JSON.parse(readFileSync(join(homedir(), ".gitlab", "storage.json"), "utf8"));
    const cfg = storage["duo-cli-config"];
    if (cfg) {
      pat = pat || cfg.gitlabAuthToken || "";
      baseUrl = baseUrl || cfg.gitlabBaseUrl || "";
    }
  } catch {/* ignore */}
}
if (!pat) {
  console.error("FATAL: no PAT. Set GITLAB_DUO_PAT, pass --pat, or run `duo login` first.");
  process.exit(2);
}
baseUrl = (baseUrl || "https://gitlab.com").replace(/\/$/, "");

// ─── Step framework ───────────────────────────────────────────────────────

let stepNum = 0;
function step(title: string) {
  stepNum++;
  console.log(`\n[${stepNum}] ${title}`);
}
function ok(msg: string) { console.log(`    ✓ ${msg}`); }
function fail(msg: string): never {
  console.error(`    ✗ ${msg}`);
  process.exit(1);
}
async function getJson(url: string, init?: RequestInit): Promise<any> {
  const r = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
}

// ─── Step 1: ensure account exists ───────────────────────────────────────

step("Verify the etteum proxy is reachable");
{
  const { status, json } = await getJson(`${proxyUrl}/api/stats`);
  if (status !== 200) fail(`proxy /api/stats returned HTTP ${status}: ${JSON.stringify(json)}`);
  ok(`proxy responding on port ${port}`);
}

step("Find or create a gitlab-duo account");
let accountId = 0;
{
  const { json } = await getJson(`${proxyUrl}/api/accounts`);
  const existing = (json.data ?? []).find((a: any) => a.provider === "gitlab-duo" && a.enabled);
  if (existing) {
    accountId = existing.id;
    ok(`reusing account #${existing.id} (${existing.email}, status=${existing.status})`);
  } else {
    const reg = await getJson(`${proxyUrl}/api/accounts/gitlab-duo`, {
      method: "POST",
      body: JSON.stringify({ gitlab_base_url: baseUrl, pat }),
    });
    if (reg.status !== 200 || !reg.json?.success) {
      fail(`account registration failed: HTTP ${reg.status}: ${JSON.stringify(reg.json)}`);
    }
    accountId = reg.json.data.id;
    ok(`registered new account #${accountId} (${reg.json.data.email})`);
  }
}

// ─── Step 2: drive an agentic conversation ───────────────────────────────

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, any>; required?: string[] };
}

const tools: AnthropicTool[] = [
  {
    name: "bash",
    description: "Run a shell command and return stdout/stderr.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string", description: "Shell command line." } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "list_directory",
    description: "List files and directories under a path.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; [k: string]: any }>;
}

const messages: AnthropicMessage[] = [{
  role: "user",
  content: "List the files in the current directory and tell me which ones are TypeScript files.",
}];

step("Drive an agentic /v1/messages loop");
const MAX_TURNS = 6;
let toolUseRounds = 0;

for (let turn = 1; turn <= MAX_TURNS; turn++) {
  const body = {
    model,
    max_tokens: 1024,
    messages,
    tools,
    stream: false,
  };

  const r = await fetch(`${proxyUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let resp: any;
  try { resp = JSON.parse(text); } catch { resp = { raw: text }; }
  if (r.status !== 200) fail(`turn ${turn}: HTTP ${r.status}: ${text.slice(0, 400)}`);
  if (resp.type === "error") fail(`turn ${turn}: ${JSON.stringify(resp.error).slice(0, 400)}`);

  const stopReason = resp.stop_reason;
  const blocks = resp.content ?? [];
  console.log(`    turn ${turn}: stop_reason=${stopReason}, blocks=${blocks.map((b: any) => b.type).join(",") || "(empty)"}`);

  // Append the assistant turn to our running history.
  messages.push({ role: "assistant", content: blocks });

  if (stopReason === "tool_use" || blocks.some((b: any) => b.type === "tool_use")) {
    toolUseRounds++;
    const toolUses = blocks.filter((b: any) => b.type === "tool_use");
    if (toolUses.length === 0) fail(`turn ${turn}: stop_reason=tool_use but no tool_use block in content`);

    // Synthesize a plausible tool_result for any tool name the bridge picked.
    const results = toolUses.map((tu: any) => {
      const lower = (tu.name ?? "").toLowerCase();
      let synthesized = "";
      if (/bash|shell|command|terminal/i.test(lower)) {
        synthesized = "$ ls\nindex.ts\nprovider.ts\nbase.ts\nREADME.md";
      } else if (/^ls$|list|tree|scan/i.test(lower)) {
        synthesized = "index.ts\nprovider.ts\nbase.ts\nREADME.md";
      } else if (/read|view/i.test(lower)) {
        synthesized = "// example file content\nexport const hello = 'world';";
      } else if (/glob|find/i.test(lower)) {
        synthesized = "index.ts\nprovider.ts\nbase.ts";
      } else if (/grep|search/i.test(lower)) {
        synthesized = "index.ts:1: export const hello = 'world';";
      } else if (/fetch|http/i.test(lower)) {
        synthesized = "<html>example</html>";
      } else {
        synthesized = "(tool result)";
      }
      return { type: "tool_result", tool_use_id: tu.id, content: synthesized };
    });
    messages.push({ role: "user", content: results });
    ok(`turn ${turn}: replied to ${toolUses.length} tool_use(s) (${toolUses.map((t: any) => t.name).join(",")})`);
    continue;
  }

  if (stopReason === "end_turn" || stopReason === "stop_sequence") {
    const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    ok(`turn ${turn}: end_turn — final text: ${JSON.stringify(text.slice(0, 160))}`);
    console.log(`\n✅ PASS — completed in ${turn} turn(s), ${toolUseRounds} tool_use round(s).`);
    process.exit(0);
  }

  fail(`turn ${turn}: unexpected stop_reason=${stopReason}`);
}

fail(`exceeded MAX_TURNS=${MAX_TURNS} without end_turn — model is looping?`);
