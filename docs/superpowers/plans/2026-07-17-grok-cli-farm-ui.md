# Grok CLI Farm UI (Etteum Automation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Grok CLI account farming from the etteum **Accounts UI** (like other providers’ bulk/login automation), driving the existing HTTP farm (`http_farm.py`) as a managed job that auto-imports into the `grok-cli` pool.

**Architecture:** Do not reimplement xAI signup in TypeScript. Etteum owns a small **GrokFarmQueue** that spawns `http_farm.py -n N -c C -y` with env `ETTEUM_URL` + `ETTEUM_API_KEY` + `GROK_PUSH_ETTEUM=true` so each success is imported via existing `POST /api/accounts/grok-cli/import`. Job state is in-memory + WS broadcast (`grok_farm_*`). Dashboard Grok “Add” dialog gets a **Farm** mode (count, concurrency, Start/Stop) beside **Import JSON**.

**Tech Stack:** Bun + TypeScript (Hono), existing dashboard React, Python `http_farm.py` at configurable path (default `C:\Users\Administrator\Documents\bot\grok-farm-share`).

**Why this shape:** Matches product expectation (automation in UI). Reuses proven HTTP farm + import API. Browser `farm.py` stays out of MVP.

---

## File map

| Path | Action | Responsibility |
|------|--------|----------------|
| `src/auth/grok-farm-queue.ts` | Create | Job lifecycle: start/stop/status, spawn python, parse progress, broadcast |
| `src/auth/grok-farm-queue.test.ts` | Create | Unit tests for parse helpers / status shape (no real farm) |
| `src/config.ts` | Modify | `grokFarmDir`, `grokFarmPython` env |
| `src/api/accounts.ts` | Modify | `POST /grok-cli/farm`, `GET /grok-cli/farm`, `POST /grok-cli/farm/stop` |
| `dashboard/src/lib/api.ts` | Modify | `startGrokFarm`, `fetchGrokFarmStatus`, `stopGrokFarm` |
| `dashboard/src/pages/Accounts.tsx` | Modify | Grok dialog: Farm tab + form + progress |
| `src/api/index.ts` | Modify | Optional: include `grok-cli` in `/api/providers` list |

**Do not:** port Boterdrop/gRPC into TS; change import normalize; require farm-share git.

**Env (etteum `.env`):**
```
GROK_FARM_DIR=C:\Users\Administrator\Documents\bot\grok-farm-share
GROK_FARM_PYTHON=py
# optional: GROK_FARM_PYTHON_ARGS=-3
# child inherits farm .env for BOTERDROP_URL / mail; parent injects:
# ETTEUM_URL, ETTEUM_API_KEY (= API_KEY), GROK_PUSH_ETTEUM=true
```

---

### Task 1: Config + pure farm-queue helpers (TDD)

**Files:**
- Create: `src/auth/grok-farm-queue.test.ts`
- Create: `src/auth/grok-farm-queue.ts` (helpers + queue class skeleton)
- Modify: `src/config.ts`

- [ ] **Step 1: Add config fields**

In `src/config.ts` (same pattern as other env reads):

```ts
// grok farm automation (HTTP subprocess)
grokFarmDir: process.env.GROK_FARM_DIR || "C:\\Users\\Administrator\\Documents\\bot\\grok-farm-share",
grokFarmPython: process.env.GROK_FARM_PYTHON || "py",
grokFarmPythonArgs: (process.env.GROK_FARM_PYTHON_ARGS || "-3").split(/\s+/).filter(Boolean),
```

- [ ] **Step 2: Write failing tests for progress parse + status defaults**

```ts
// src/auth/grok-farm-queue.test.ts
import { describe, expect, test } from "bun:test";
import { parseGrokFarmLogLine, createIdleGrokFarmStatus } from "./grok-farm-queue";

describe("createIdleGrokFarmStatus", () => {
  test("idle shape", () => {
    const s = createIdleGrokFarmStatus();
    expect(s.running).toBe(false);
    expect(s.target).toBe(0);
    expect(s.success).toBe(0);
    expect(s.failed).toBe(0);
  });
});

describe("parseGrokFarmLogLine", () => {
  test("detects OK summary", () => {
    const p = parseGrokFarmLogLine(" OK 3  FAIL 1  TOTAL 5  OUT C:\\x\\batch_1");
    expect(p?.kind).toBe("summary");
    expect(p?.success).toBe(3);
    expect(p?.failed).toBe(1);
  });

  test("detects batch dir", () => {
    const p = parseGrokFarmLogLine("[BATCH] dir=C:\\farm\\results\\batch_abc");
    expect(p?.kind).toBe("batch_dir");
    expect(p?.batchDir).toContain("batch_abc");
  });
});
```

- [ ] **Step 3: Run tests — FAIL**

```powershell
cd C:\Users\Administrator\etteum-pool
bun test src/auth/grok-farm-queue.test.ts
```

- [ ] **Step 4: Implement `grok-farm-queue.ts` (status + parse + queue)**

```ts
// src/auth/grok-farm-queue.ts
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { config } from "../config";
import { broadcast } from "../ws/index";
import { pool } from "../proxy/pool";

export type GrokFarmStatus = {
  running: boolean;
  target: number;
  concurrent: number;
  success: number;
  failed: number;
  pushFailures: number;
  startedAt: string | null;
  finishedAt: string | null;
  batchDir: string | null;
  lastMessage: string;
  error: string | null;
  pid: number | null;
};

export function createIdleGrokFarmStatus(): GrokFarmStatus {
  return {
    running: false,
    target: 0,
    concurrent: 0,
    success: 0,
    failed: 0,
    pushFailures: 0,
    startedAt: null,
    finishedAt: null,
    batchDir: null,
    lastMessage: "",
    error: null,
    pid: null,
  };
}

export type GrokFarmLogParse =
  | { kind: "summary"; success: number; failed: number }
  | { kind: "batch_dir"; batchDir: string }
  | { kind: "progress"; message: string }
  | null;

export function parseGrokFarmLogLine(line: string): GrokFarmLogParse {
  const s = line.trim();
  // " OK 3  FAIL 1  TOTAL 5  OUT ..."
  let m = s.match(/OK\s+(\d+)\s+FAIL\s+(\d+)/i);
  if (m) return { kind: "summary", success: Number(m[1]), failed: Number(m[2]) };
  m = s.match(/\[BATCH\]\s*dir=(.+)/i);
  if (m) return { kind: "batch_dir", batchDir: m[1]!.trim() };
  if (/ERROR:|etteum preflight|push fail/i.test(s)) {
    return { kind: "progress", message: s.slice(0, 300) };
  }
  return null;
}

class GrokFarmQueue {
  private status: GrokFarmStatus = createIdleGrokFarmStatus();
  private child: ChildProcess | null = null;

  getStatus(): GrokFarmStatus {
    return { ...this.status };
  }

  private setStatus(patch: Partial<GrokFarmStatus>) {
    this.status = { ...this.status, ...patch };
    broadcast({ type: "grok_farm_status", data: this.getStatus() });
  }

  start(opts: { count: number; concurrent: number }): { ok: true; status: GrokFarmStatus } | { ok: false; error: string } {
    if (this.status.running || this.child) {
      return { ok: false, error: "Grok farm already running" };
    }
    const count = Math.max(1, Math.min(1000, Math.floor(opts.count)));
    const concurrent = Math.max(1, Math.min(20, Math.floor(opts.concurrent)));
    const farmDir = config.grokFarmDir;
    const script = path.join(farmDir, "http_farm.py");
    // Verify script exists
    try {
      const f = Bun.file(script);
      // sync check via exists
    } catch { /* fall through */ }
    const exists = require("node:fs").existsSync(script);
    if (!exists) {
      return { ok: false, error: `http_farm.py not found at ${script}. Set GROK_FARM_DIR.` };
    }

    const apiKey = process.env.API_KEY || "";
    if (!apiKey) return { ok: false, error: "API_KEY not set (needed for farm push to etteum)" };

    const port = process.env.PORT || "1930";
    const etteumUrl = process.env.ETTEUM_PUBLIC_URL || `http://127.0.0.1:${port}`;

    this.setStatus({
      ...createIdleGrokFarmStatus(),
      running: true,
      target: count,
      concurrent,
      startedAt: new Date().toISOString(),
      lastMessage: "starting http_farm.py",
    });

    const args = [
      ...config.grokFarmPythonArgs,
      script,
      "-n", String(count),
      "-c", String(concurrent),
      "-y",
      "--push",
    ];
    // When python is "py", args already include -3 then script...
    // Prefer: spawn(python, [...pythonArgs, script, farmArgs])
    const py = config.grokFarmPython;
    const spawnArgs =
      py === "py" || py.endsWith("py.exe")
        ? [...config.grokFarmPythonArgs, script, "-n", String(count), "-c", String(concurrent), "-y", "--push"]
        : [script, "-n", String(count), "-c", String(concurrent), "-y", "--push"];

    const child = spawn(py, spawnArgs, {
      cwd: farmDir,
      env: {
        ...process.env,
        ETTEUM_URL: etteumUrl,
        ETTEUM_API_KEY: apiKey,
        API_KEY: apiKey,
        GROK_PUSH_ETTEUM: "true",
        GROK_PUSH_MODE: "per_success",
        PYTHONUNBUFFERED: "1",
      },
      windowsHide: true,
    });
    this.child = child;
    this.setStatus({ pid: child.pid ?? null });

    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) this.handleLine(line);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      this.child = null;
      this.setStatus({
        running: false,
        finishedAt: new Date().toISOString(),
        error: err.message,
        lastMessage: `spawn error: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      this.child = null;
      pool.invalidate("grok-cli" as any);
      this.setStatus({
        running: false,
        finishedAt: new Date().toISOString(),
        lastMessage: code === 0 ? "farm finished" : `farm exit ${code}`,
        error: code && code !== 0 ? `exit ${code}` : this.status.error,
      });
      broadcast({ type: "grok_farm_complete", data: this.getStatus() });
      broadcast({ type: "accounts_bulk_created", data: { count: this.status.success, provider: "grok-cli" } });
    });

    broadcast({ type: "grok_farm_started", data: this.getStatus() });
    return { ok: true, status: this.getStatus() };
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    const p = parseGrokFarmLogLine(line);
    if (!p) {
      // keep last short progress for UI
      if (line.length < 200) this.setStatus({ lastMessage: line.trim().slice(0, 200) });
      return;
    }
    if (p.kind === "summary") {
      this.setStatus({ success: p.success, failed: p.failed, lastMessage: line.trim().slice(0, 200) });
    } else if (p.kind === "batch_dir") {
      this.setStatus({ batchDir: p.batchDir, lastMessage: `batch ${p.batchDir}` });
    } else if (p.kind === "progress") {
      this.setStatus({ lastMessage: p.message });
    }
  }

  stop(): { ok: true } | { ok: false; error: string } {
    if (!this.child) return { ok: false, error: "No farm process running" };
    try {
      this.child.kill();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    this.child = null;
    this.setStatus({
      running: false,
      finishedAt: new Date().toISOString(),
      lastMessage: "stopped by user",
    });
    return { ok: true };
  }
}

export const grokFarmQueue = new GrokFarmQueue();
```

**Note:** Use `import { existsSync } from "node:fs"` instead of require. Fix spawn args so `py -3 http_farm.py ...` works on Windows.

- [ ] **Step 5: Tests PASS**

```powershell
bun test src/auth/grok-farm-queue.test.ts
```

- [ ] **Step 6: Commit**

```powershell
git add src/config.ts src/auth/grok-farm-queue.ts src/auth/grok-farm-queue.test.ts
git commit -m "feat(grok-cli): farm queue subprocess + status helpers"
```

---

### Task 2: API routes

**Files:**
- Modify: `src/api/accounts.ts`

- [ ] **Step 1: Import queue**

```ts
import { grokFarmQueue } from "../auth/grok-farm-queue";
```

- [ ] **Step 2: Routes (near grok-cli/import)**

```ts
/** POST /api/accounts/grok-cli/farm  body: { count: number, concurrent?: number } */
accountsRouter.post("/grok-cli/farm", async (c) => {
  const body = await c.req.json<{ count?: number; concurrent?: number }>().catch(() => ({} as any));
  const count = Number(body.count);
  if (!Number.isFinite(count) || count < 1) {
    return c.json({ error: "count >= 1 required" }, 400);
  }
  const concurrent = Number(body.concurrent) > 0 ? Number(body.concurrent) : 1;
  const result = grokFarmQueue.start({ count, concurrent });
  if (!result.ok) return c.json({ error: result.error }, 409);
  return c.json({ data: result.status });
});

/** GET /api/accounts/grok-cli/farm */
accountsRouter.get("/grok-cli/farm", (c) => {
  return c.json({ data: grokFarmQueue.getStatus() });
});

/** POST /api/accounts/grok-cli/farm/stop */
accountsRouter.post("/grok-cli/farm/stop", (c) => {
  const result = grokFarmQueue.stop();
  if (!result.ok) return c.json({ error: result.error }, 409);
  return c.json({ data: grokFarmQueue.getStatus() });
});
```

- [ ] **Step 3: Smoke (server must run)**

```powershell
$key = (Select-String -Path .env -Pattern '^API_KEY=(.+)$').Matches.Groups[1].Value
Invoke-RestMethod http://localhost:1930/api/accounts/grok-cli/farm -Headers @{Authorization="Bearer $key"} | ConvertTo-Json
```

Expected: `{ data: { running: false, ... } }`

- [ ] **Step 4: Commit**

```powershell
git add src/api/accounts.ts
git commit -m "feat(grok-cli): API start/status/stop farm jobs"
```

---

### Task 3: Dashboard API helpers + Farm UI

**Files:**
- Modify: `dashboard/src/lib/api.ts`
- Modify: `dashboard/src/pages/Accounts.tsx`

- [ ] **Step 1: api.ts**

```ts
export type GrokFarmStatus = {
  running: boolean;
  target: number;
  concurrent: number;
  success: number;
  failed: number;
  pushFailures: number;
  startedAt: string | null;
  finishedAt: string | null;
  batchDir: string | null;
  lastMessage: string;
  error: string | null;
  pid: number | null;
};

export async function fetchGrokFarmStatus() {
  return fetchApi<{ data: GrokFarmStatus }>(`/api/accounts/grok-cli/farm`);
}

export async function startGrokFarm(payload: { count: number; concurrent?: number }) {
  return fetchApi<{ data: GrokFarmStatus }>(`/api/accounts/grok-cli/farm`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function stopGrokFarm() {
  return fetchApi<{ data: GrokFarmStatus }>(`/api/accounts/grok-cli/farm/stop`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
```

- [ ] **Step 2: Accounts.tsx Grok dialog**

When `addDialogProvider === "grok-cli"`:
- Mode toggle: **Farm** | **Import JSON** (default Farm for automation)
- Farm fields: count (number), concurrent (number), buttons Start / Stop
- Poll `fetchGrokFarmStatus` every 2s while dialog open or farm running
- WS: `useWsEvent` for `grok_farm_status` / `grok_farm_complete` → refresh status + `loadAccounts()`
- Show progress: success/failed/target, lastMessage, error
- Keep existing Import JSON textarea path

Sketch handlers:

```ts
const [grokMode, setGrokMode] = useState<"farm" | "import">("farm");
const [farmCount, setFarmCount] = useState(5);
const [farmConcurrent, setFarmConcurrent] = useState(2);
const [farmStatus, setFarmStatus] = useState<GrokFarmStatus | null>(null);

async function handleGrokFarmStart() {
  const res = await startGrokFarm({ count: farmCount, concurrent: farmConcurrent });
  setFarmStatus(res.data);
  showSuccess("Grok farm started");
}
async function handleGrokFarmStop() {
  const res = await stopGrokFarm();
  setFarmStatus(res.data);
}
```

UI copy: “HTTP farm (no browser). Needs Boterdrop + tempmail. Accounts auto-import to pool.”

- [ ] **Step 3: Build dashboard**

```powershell
cd dashboard; bun run build
```

- [ ] **Step 4: Commit**

```powershell
git add dashboard/src/lib/api.ts dashboard/src/pages/Accounts.tsx
git commit -m "feat(grok-cli): dashboard Farm automation UI"
```

---

### Task 4: Providers list + .env.example note

**Files:**
- Modify: `src/api/index.ts` providers array include `grok-cli` (and youmind/gitlab if missing — only add grok-cli)
- Modify: `.env.example` if present with GROK_FARM_* 

- [ ] **Step 1**

```ts
return c.json({ data: [..., "youmind", "grok-cli"] });
```

- [ ] **Step 2: Commit**

```powershell
git add src/api/index.ts .env.example
git commit -m "feat(grok-cli): register farm env and providers list"
```

---

### Task 5: Manual E2E (infra-dependent)

- [ ] Restart etteum  
- [ ] UI: Accounts → Grok CLI → Farm → count 1 → Start  
- [ ] If Boterdrop down: API/UI shows farm exit error (acceptable); status not stuck running  
- [ ] If Boterdrop up: 1 account appears in pool  

---

## Spec coverage

| Need | Task |
|------|------|
| Automation in UI like other providers | 3 |
| HTTP not browser | 1 (spawns http_farm.py) |
| Auto import pool | farm --push + existing import |
| Progress | 1–3 WS + poll |
| Stop | 2–3 |
| Import JSON still works | 3 keep |

---

## Done definition

1. Unit tests parse/status pass  
2. GET farm status 200  
3. UI shows Farm form for Grok CLI  
4. Start spawns process (or clear error if script/solver missing)  
5. On success path, accounts land in `grok-cli` pool  

---

## Out of scope

- Pure-TS reimplementation of signup  
- Boterdrop install UI  
- Multi-node farm workers  
)
