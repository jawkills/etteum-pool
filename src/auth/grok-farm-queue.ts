import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config";
import { broadcast } from "../ws/index";
import { pool } from "../proxy/pool";
import { addAuthLog } from "./logs";

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
  | { kind: "step"; attempt: number; email?: string; step: string; detail?: string }
  | { kind: "ok"; attempt: number; email?: string; detail?: string }
  | { kind: "fail"; attempt: number; email?: string; detail?: string }
  | { kind: "progress"; message: string }
  | null;

/**
 * Parse http_farm.py log lines (GROK_UI=log format):
 *   12:34:56  [STEP]  #1  user@x.com  OTP
 *   12:34:56  [OK]  #1  user@x.com  12s
 *   12:34:56  [FAIL]  #1  user@x.com  CAPTCHA:FAIL
 *   [BATCH] dir=...
 *    OK 3  FAIL 1  TOTAL 5  OUT ...
 */
export function parseGrokFarmLogLine(line: string): GrokFarmLogParse {
  const s = line.trim();
  if (!s) return null;

  let m = s.match(/OK\s+(\d+)\s+FAIL\s+(\d+)/i);
  if (m && !s.includes("[OK]")) {
    return { kind: "summary", success: Number(m[1]), failed: Number(m[2]) };
  }

  m = s.match(/\[BATCH\]\s*dir=(.+)/i);
  if (m) return { kind: "batch_dir", batchDir: m[1]!.trim() };

  // [STEP] #N email? detail?
  m = s.match(/\[STEP\]\s*#(\d+)(?:\s+(\S+@\S+))?(?:\s+(.+))?$/i);
  if (m) {
    return {
      kind: "step",
      attempt: Number(m[1]),
      email: m[2] || undefined,
      step: (m[3] || "progress").trim(),
      detail: m[3]?.trim(),
    };
  }

  m = s.match(/\[OK\]\s*#(\d+)(?:\s+(\S+@\S+))?(?:\s+(.+))?$/i);
  if (m) {
    return {
      kind: "ok",
      attempt: Number(m[1]),
      email: m[2] || undefined,
      detail: m[3]?.trim(),
    };
  }

  m = s.match(/\[FAIL\]\s*#(\d+)(?:\s+(\S+@\S+))?(?:\s+(.+))?$/i);
  if (m) {
    return {
      kind: "fail",
      attempt: Number(m[1]),
      email: m[2] || undefined,
      detail: m[3]?.trim(),
    };
  }

  if (/ERROR:|etteum preflight|push fail|spawn error/i.test(s)) {
    return { kind: "progress", message: s.slice(0, 300) };
  }

  return null;
}

class GrokFarmQueue {
  private status: GrokFarmStatus = createIdleGrokFarmStatus();
  private child: ChildProcess | null = null;
  /** attempt# → last known email for grouping Bot Logs */
  private attemptEmail = new Map<number, string>();

  getStatus(): GrokFarmStatus {
    return { ...this.status };
  }

  private setStatus(patch: Partial<GrokFarmStatus>) {
    this.status = { ...this.status, ...patch };
    broadcast({ type: "grok_farm_status", data: this.getStatus() });
  }

  private emitLog(entry: {
    type: string;
    email?: string;
    step?: string;
    message?: string;
    error?: string;
    data?: unknown;
  }) {
    const log = addAuthLog({
      provider: "grok-cli",
      ...entry,
    });
    broadcast({
      type: entry.type,
      data: {
        ...log,
        provider: "grok-cli",
        email: entry.email || log.email,
        step: entry.step || log.step,
        message: entry.message || log.message,
        error: entry.error || log.error,
      },
    });
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

    this.attemptEmail.clear();
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
        // Force line logs (not HUD) so etteum can parse STEP/OK/FAIL
        GROK_UI: "log",
        GROK_VERBOSE: "true",
        PYTHONUNBUFFERED: "1",
      },
      windowsHide: true,
    });

    this.child = child;
    this.setStatus({ pid: child.pid ?? null });

    this.emitLog({
      type: "grok_farm_started",
      step: "start",
      message: `Grok farm started: target=${count} concurrent=${concurrent}`,
      data: { target: count, concurrent },
    });

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
      this.emitLog({
        type: "grok_farm_failed",
        step: "spawn",
        message: `spawn error: ${err.message}`,
        error: err.message,
      });
    });

    child.on("close", (code) => {
      this.child = null;
      pool.invalidate("grok-cli" as any);
      const ok = code === 0;
      this.setStatus({
        running: false,
        finishedAt: new Date().toISOString(),
        lastMessage: ok ? "farm finished" : `farm exit ${code}`,
        error: !ok ? `exit ${code}` : this.status.error,
      });
      this.emitLog({
        type: ok ? "grok_farm_complete" : "grok_farm_failed",
        step: "complete",
        message: ok
          ? `Farm complete: ${this.status.success} ok, ${this.status.failed} fail / ${this.status.target}`
          : `Farm exited ${code}: ${this.status.success} ok, ${this.status.failed} fail`,
        error: !ok ? `exit ${code}` : undefined,
        data: this.getStatus(),
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
      this.emitLog({
        type: "grok_farm_progress",
        step: "summary",
        message: `Summary: ${p.success} ok, ${p.failed} fail`,
        data: { success: p.success, failed: p.failed },
      });
      return;
    }

    if (p.kind === "batch_dir") {
      this.setStatus({ batchDir: p.batchDir, lastMessage: `batch ${p.batchDir}` });
      this.emitLog({
        type: "grok_farm_progress",
        step: "batch",
        message: `Batch dir: ${p.batchDir}`,
        data: { batchDir: p.batchDir },
      });
      return;
    }

    if (p.kind === "step") {
      if (p.email) this.attemptEmail.set(p.attempt, p.email);
      const email = p.email || this.attemptEmail.get(p.attempt);
      this.setStatus({ lastMessage: `#${p.attempt} ${p.step}${email ? ` ${email}` : ""}`.slice(0, 200) });
      this.emitLog({
        type: "grok_farm_progress",
        email,
        step: p.step,
        message: `#${p.attempt} ${p.step}${p.detail && p.detail !== p.step ? ` · ${p.detail}` : ""}`,
        data: { attempt: p.attempt, step: p.step },
      });
      return;
    }

    if (p.kind === "ok") {
      if (p.email) this.attemptEmail.set(p.attempt, p.email);
      const email = p.email || this.attemptEmail.get(p.attempt);
      const success = this.status.success + 1;
      this.setStatus({
        success,
        lastMessage: `OK #${p.attempt} ${email || ""}`.trim().slice(0, 200),
      });
      this.emitLog({
        type: "grok_farm_success",
        email,
        step: "done",
        message: `Account ready${email ? `: ${email}` : ` #${p.attempt}`}${p.detail ? ` (${p.detail})` : ""}`,
        data: { attempt: p.attempt, success, target: this.status.target },
      });
      return;
    }

    if (p.kind === "fail") {
      if (p.email) this.attemptEmail.set(p.attempt, p.email);
      const email = p.email || this.attemptEmail.get(p.attempt);
      const failed = this.status.failed + 1;
      const isPush = /push/i.test(p.detail || "");
      this.setStatus({
        failed,
        pushFailures: isPush ? this.status.pushFailures + 1 : this.status.pushFailures,
        lastMessage: `FAIL #${p.attempt} ${p.detail || ""}`.trim().slice(0, 200),
      });
      this.emitLog({
        type: "grok_farm_failed",
        email,
        step: p.detail?.split(":")[0] || "fail",
        message: `Failed #${p.attempt}${email ? ` ${email}` : ""}${p.detail ? `: ${p.detail}` : ""}`,
        error: p.detail || "fail",
        data: { attempt: p.attempt, failed, target: this.status.target },
      });
      return;
    }

    if (p.kind === "progress") {
      this.setStatus({ lastMessage: p.message, error: /ERROR/i.test(p.message) ? p.message : this.status.error });
      this.emitLog({
        type: "grok_farm_progress",
        step: "info",
        message: p.message,
        error: /ERROR/i.test(p.message) ? p.message : undefined,
      });
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
    this.emitLog({
      type: "grok_farm_failed",
      step: "stop",
      message: "Farm stopped by user",
      error: "stopped",
    });
    return { ok: true };
  }
}

export const grokFarmQueue = new GrokFarmQueue();
