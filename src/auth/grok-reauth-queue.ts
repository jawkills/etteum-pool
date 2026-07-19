/**
 * Grok CLI reauth job queue — login existing email+password via http_farm --reauth-file.
 * Mirrors grok-farm-queue spawn/status/log patterns without bloating that module.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index";
import { accounts } from "../db/schema";
import { decrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import { pool } from "../proxy/pool";
import { isPermanentRevocation, isPlaceholderPassword } from "../proxy/account-health";
import { addAuthLog } from "./logs";
import { parseGrokFarmLogLine } from "./grok-farm-queue";
import {
  grokFarmChildEnv,
  resolveGrokFarmApiKey,
  resolveGrokFarmPython,
} from "./grok-farm-spawn";

export type GrokReauthStatus = {
  running: boolean;
  target: number;
  concurrent: number;
  success: number;
  failed: number;
  skipped: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastMessage: string;
  error: string | null;
  pid: number | null;
  jobFile: string | null;
};

export function createIdleGrokReauthStatus(): GrokReauthStatus {
  return {
    running: false,
    target: 0,
    concurrent: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    startedAt: null,
    finishedAt: null,
    lastMessage: "",
    error: null,
    pid: null,
    jobFile: null,
  };
}

export type GrokReauthJob = { email: string; password: string };

function resolvePassword(account: { password: string; email: string }): string | null {
  try {
    const plain = decrypt(account.password);
    if (isPlaceholderPassword(plain)) return null;
    return plain;
  } catch {
    return null;
  }
}

class GrokReauthQueue {
  private status: GrokReauthStatus = createIdleGrokReauthStatus();
  private child: ChildProcess | null = null;
  private startLock = false;
  private jobDir: string | null = null;

  getStatus(): GrokReauthStatus {
    return { ...this.status };
  }

  private setStatus(patch: Partial<GrokReauthStatus>) {
    this.status = { ...this.status, ...patch };
    broadcast({ type: "grok_reauth_status", data: this.getStatus() });
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
        logId: log.id,
        timestamp: log.timestamp,
        type: entry.type,
        provider: "grok-cli",
        email: entry.email || log.email,
        step: entry.step || log.step,
        message: entry.message || log.message,
        error: entry.error || log.error,
        data: entry.data,
      },
    });
  }

  /**
   * Build reauth jobs from DB (dead/error with stored password) or explicit ids.
   */
  async resolveJobs(opts: {
    ids?: number[];
    onlyDead?: boolean;
    defaultPassword?: string;
  }): Promise<{ jobs: GrokReauthJob[]; skipped: Array<{ id: number; email: string; reason: string }> }> {
    const skipped: Array<{ id: number; email: string; reason: string }> = [];
    let rows =
      opts.ids && opts.ids.length > 0
        ? await db
            .select()
            .from(accounts)
            .where(inArray(accounts.id, opts.ids.map(Number).filter(Number.isFinite)))
        : await db.select().from(accounts).where(eq(accounts.provider, "grok-cli"));

    rows = rows.filter((r) => r.provider === "grok-cli");

    if (opts.onlyDead !== false && !(opts.ids && opts.ids.length > 0)) {
      rows = rows.filter(
        (r) =>
          r.status === "error" ||
          isPermanentRevocation(r.errorMessage) ||
          (r.errorMessage || "").toLowerCase().includes("invalid_grant")
      );
    }

    const jobs: GrokReauthJob[] = [];
    const defaultPw = (opts.defaultPassword || process.env.GROK_PASSWORD || "").trim();

    for (const r of rows) {
      let pw = resolvePassword(r);
      if (!pw && defaultPw) pw = defaultPw;
      if (!pw) {
        skipped.push({
          id: r.id,
          email: r.email,
          reason: "no stored password (re-farm or import with password first)",
        });
        continue;
      }
      jobs.push({ email: r.email, password: pw });
    }

    return { jobs, skipped };
  }

  async start(opts: {
    ids?: number[];
    onlyDead?: boolean;
    concurrent?: number;
    defaultPassword?: string;
  }): Promise<
    | { ok: true; status: GrokReauthStatus; skipped: number }
    | { ok: false; error: string }
  > {
    if (this.startLock || this.status.running || this.child) {
      return { ok: false, error: "Grok reauth already running" };
    }
    this.startLock = true;

    try {
      const py = resolveGrokFarmPython();
      if (!py.ok) {
        this.startLock = false;
        return { ok: false, error: py.error };
      }

      const { jobs, skipped } = await this.resolveJobs({
        ids: opts.ids,
        onlyDead: opts.onlyDead,
        defaultPassword: opts.defaultPassword,
      });

      if (jobs.length === 0) {
        this.startLock = false;
        return {
          ok: false,
          error:
            skipped.length > 0
              ? `No reauthable accounts (${skipped.length} skipped: missing password)`
              : "No grok-cli accounts eligible for reauth",
        };
      }

      const key = await resolveGrokFarmApiKey();
      if (!key.ok) {
        this.startLock = false;
        return { ok: false, error: key.error };
      }

      const concurrent = Math.max(1, Math.min(10, Math.floor(opts.concurrent || 2)));
      const jobDir = mkdtempSync(path.join(tmpdir(), "grok-reauth-"));
      const jobFile = path.join(jobDir, "jobs.json");
      writeFileSync(jobFile, JSON.stringify(jobs, null, 0), "utf8");
      this.jobDir = jobDir;

      const { farmDir, script, pyBin, pyArgs } = py.value;
      const { apiKey, etteumUrl } = key;

      this.setStatus({
        ...createIdleGrokReauthStatus(),
        running: true,
        target: jobs.length,
        concurrent,
        skipped: skipped.length,
        startedAt: new Date().toISOString(),
        lastMessage: "starting reauth http_farm.py",
        jobFile,
      });

      const spawnArgs = [
        ...pyArgs,
        script,
        "--reauth-file",
        jobFile,
        "-c",
        String(concurrent),
        "-y",
        "--push",
      ];

      const child = spawn(pyBin, spawnArgs, {
        cwd: farmDir,
        env: grokFarmChildEnv(apiKey, etteumUrl),
        windowsHide: true,
      });

      this.child = child;
      this.setStatus({ pid: child.pid ?? null });

      this.emitLog({
        type: "grok_reauth_started",
        step: "start",
        message: `Grok reauth started: target=${jobs.length} concurrent=${concurrent} skipped=${skipped.length}`,
        data: { target: jobs.length, concurrent, skipped: skipped.length },
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
        this.startLock = false;
        this.cleanupJobDir();
        this.setStatus({
          running: false,
          finishedAt: new Date().toISOString(),
          error: err.message,
          lastMessage: `spawn error: ${err.message}`,
        });
        this.emitLog({
          type: "grok_reauth_failed",
          step: "spawn",
          message: `spawn error: ${err.message}`,
          error: err.message,
        });
      });

      child.on("close", (code) => {
        this.child = null;
        this.startLock = false;
        this.cleanupJobDir();
        pool.invalidate("grok-cli" as any);
        const ok = code === 0;
        this.setStatus({
          running: false,
          finishedAt: new Date().toISOString(),
          lastMessage: ok ? "reauth finished" : `reauth exit ${code}`,
          // Clear stale error on success; record exit code on failure.
          error: ok ? null : `exit ${code}`,
        });
        this.emitLog({
          type: ok ? "grok_reauth_complete" : "grok_reauth_failed",
          step: "complete",
          message: ok
            ? `Reauth complete: ${this.status.success} ok, ${this.status.failed} fail / ${this.status.target}`
            : `Reauth exited ${code}: ${this.status.success} ok, ${this.status.failed} fail`,
          error: !ok ? `exit ${code}` : undefined,
          data: this.getStatus(),
        });
        if (ok) {
          broadcast({ type: "grok_reauth_complete", data: this.getStatus() });
          if (this.status.success > 0) {
            broadcast({
              type: "accounts_bulk_created",
              data: { count: this.status.success, provider: "grok-cli" },
            });
          }
        } else {
          broadcast({ type: "grok_reauth_failed", data: this.getStatus() });
        }
      });

      broadcast({ type: "grok_reauth_started", data: this.getStatus() });
      return { ok: true, status: this.getStatus(), skipped: skipped.length };
    } catch (err) {
      this.startLock = false;
      this.child = null;
      this.cleanupJobDir();
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  stop(): { ok: true } | { ok: false; error: string } {
    if (!this.child) {
      return { ok: false, error: "No reauth job running" };
    }
    try {
      this.child.kill();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true };
  }

  private cleanupJobDir() {
    if (this.jobDir) {
      try {
        rmSync(this.jobDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      this.jobDir = null;
    }
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
      return;
    }
    if (p.kind === "ok") {
      this.setStatus({
        success: this.status.success + 1,
        lastMessage: p.email ? `ok ${p.email}` : "ok",
      });
      this.emitLog({
        type: "grok_reauth_success",
        email: p.email,
        step: "ok",
        message: p.detail || "reauth ok",
      });
      return;
    }
    if (p.kind === "fail") {
      this.setStatus({
        failed: this.status.failed + 1,
        lastMessage: p.detail || "fail",
      });
      this.emitLog({
        type: "grok_reauth_failed",
        email: p.email,
        step: "fail",
        message: p.detail || "reauth fail",
        error: p.detail,
      });
      return;
    }
    if (p.kind === "step") {
      this.setStatus({ lastMessage: `${p.step} ${p.email || ""}`.trim() });
      this.emitLog({
        type: "grok_reauth_progress",
        email: p.email,
        step: p.step,
        message: p.detail || p.step,
      });
      return;
    }
    if (p.kind === "progress") {
      this.setStatus({ lastMessage: p.message.slice(0, 200) });
    }
  }
}

export const grokReauthQueue = new GrokReauthQueue();
