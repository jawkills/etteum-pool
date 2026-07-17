import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
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

  start(opts: {
    count: number;
    concurrent: number;
  }): { ok: true; status: GrokFarmStatus } | { ok: false; error: string } {
    if (this.status.running || this.child) {
      return { ok: false, error: "Grok farm already running" };
    }

    const count = Math.max(1, Math.min(1000, Math.floor(opts.count)));
    const concurrent = Math.max(1, Math.min(20, Math.floor(opts.concurrent)));
    const farmDir = config.grokFarmDir;
    const script = path.join(farmDir, "http_farm.py");

    if (!existsSync(script)) {
      return { ok: false, error: `http_farm.py not found at ${script}. Set GROK_FARM_DIR.` };
    }

    const apiKey = config.apiKey;
    if (!apiKey) {
      return { ok: false, error: "API_KEY not set (needed for farm push to etteum)" };
    }

    const etteumUrl = process.env.ETTEUM_PUBLIC_URL || `http://127.0.0.1:${config.port}`;

    this.setStatus({
      ...createIdleGrokFarmStatus(),
      running: true,
      target: count,
      concurrent,
      startedAt: new Date().toISOString(),
      lastMessage: "starting http_farm.py",
    });

    const spawnArgs = [
      ...config.grokFarmPythonArgs,
      script,
      "-n",
      String(count),
      "-c",
      String(concurrent),
      "-y",
      "--push",
    ];

    const child = spawn(config.grokFarmPython, spawnArgs, {
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
      broadcast({
        type: "accounts_bulk_created",
        data: { count: this.status.success, provider: "grok-cli" },
      });
    });

    broadcast({ type: "grok_farm_started", data: this.getStatus() });
    return { ok: true, status: this.getStatus() };
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    const p = parseGrokFarmLogLine(line);
    if (!p) {
      if (line.length < 200) this.setStatus({ lastMessage: line.trim().slice(0, 200) });
      return;
    }
    if (p.kind === "summary") {
      this.setStatus({
        success: p.success,
        failed: p.failed,
        lastMessage: line.trim().slice(0, 200),
      });
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
