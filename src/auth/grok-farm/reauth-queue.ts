/**
 * Grok CLI reauth job — login existing email+password via http_farm --reauth-file.
 * Lifecycle shared with farm via grok-farm-process (no clone of spawn/stop/line buffer).
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { broadcast } from "../../ws/index";
import { parseGrokFarmLogLine } from "./log";
import {
  emitGrokProcessLog,
  GrokProcessLatch,
  invalidateGrokCliPool,
  killGrokFarmChild,
  spawnGrokFarmChild,
} from "./process";
import { resolveGrokReauthJobs } from "./reauth-jobs";

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

export type { GrokReauthJob } from "./reauth-jobs";

class GrokReauthQueue {
  private status: GrokReauthStatus = createIdleGrokReauthStatus();
  private latch = new GrokProcessLatch();
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
    emitGrokProcessLog(entry);
  }

  /** Exposed for tests / API that need job preview. */
  resolveJobs = resolveGrokReauthJobs;

  async start(opts: {
    ids?: number[];
    onlyDead?: boolean;
    concurrent?: number;
    defaultPassword?: string;
  }): Promise<
    | { ok: true; status: GrokReauthStatus; skipped: number }
    | { ok: false; error: string }
  > {
    const generation = this.latch.tryAcquire();
    if (generation == null) {
      return { ok: false, error: "Grok reauth already running" };
    }

    try {
      const { jobs, skipped } = await resolveGrokReauthJobs({
        ids: opts.ids,
        onlyDead: opts.onlyDead,
        defaultPassword: opts.defaultPassword,
      });

      if (jobs.length === 0) {
        this.latch.forceClear();
        return {
          ok: false,
          error:
            skipped.length > 0
              ? `No reauthable accounts (${skipped.length} skipped: missing password)`
              : "No grok-cli accounts eligible for reauth",
        };
      }

      const concurrent = Math.max(1, Math.min(10, Math.floor(opts.concurrent || 2)));
      const jobDir = mkdtempSync(path.join(tmpdir(), "grok-reauth-"));
      const jobFile = path.join(jobDir, "jobs.json");
      writeFileSync(jobFile, JSON.stringify(jobs, null, 0), "utf8");
      this.jobDir = jobDir;

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

      const spawned = await spawnGrokFarmChild({
        args: ["--reauth-file", jobFile, "-c", String(concurrent), "-y", "--push"],
        onLine: (line) => this.handleLine(line),
        onSpawnError: (err) => {
          if (!this.latch.release(generation)) return;
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
        },
        onClose: (code) => {
          if (!this.latch.release(generation)) return;
          this.cleanupJobDir();
          invalidateGrokCliPool();
          const ok = code === 0;
          this.setStatus({
            running: false,
            finishedAt: new Date().toISOString(),
            lastMessage: ok ? "reauth finished" : `reauth exit ${code}`,
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
            // Refresh UI lists without lying that accounts were created.
            if (this.status.success > 0) {
              broadcast({
                type: "accounts_updated",
                data: { count: this.status.success, provider: "grok-cli", reason: "reauth" },
              });
            }
          } else {
            broadcast({ type: "grok_reauth_failed", data: this.getStatus() });
          }
        },
      });

      if (!spawned.ok) {
        this.latch.forceClear();
        this.cleanupJobDir();
        this.setStatus({
          running: false,
          finishedAt: new Date().toISOString(),
          error: spawned.error,
          lastMessage: spawned.error,
        });
        return { ok: false, error: spawned.error };
      }

      this.latch.setChild(spawned.child);
      this.setStatus({ pid: spawned.child.pid ?? null });

      this.emitLog({
        type: "grok_reauth_started",
        step: "start",
        message: `Grok reauth started: target=${jobs.length} concurrent=${concurrent} skipped=${skipped.length}`,
        data: { target: jobs.length, concurrent, skipped: skipped.length },
      });

      broadcast({ type: "grok_reauth_started", data: this.getStatus() });
      return { ok: true, status: this.getStatus(), skipped: skipped.length };
    } catch (err) {
      this.latch.forceClear();
      this.cleanupJobDir();
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  stop(): { ok: true } | { ok: false; error: string } {
    const child = this.latch.currentChild;
    const killed = killGrokFarmChild(child);
    if (!killed.ok) {
      return {
        ok: false,
        error: killed.error === "No process running" ? "No reauth job running" : killed.error,
      };
    }

    this.latch.forceClear();
    this.cleanupJobDir();
    this.setStatus({
      running: false,
      finishedAt: new Date().toISOString(),
      lastMessage: "stopped by user",
      error: "stopped",
      pid: null,
    });
    this.emitLog({
      type: "grok_reauth_failed",
      step: "stop",
      message: "Reauth stopped by user",
      error: "stopped",
    });
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
