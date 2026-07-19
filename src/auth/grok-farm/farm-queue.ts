/**
 * Grok CLI farm job — signup batch via http_farm.py.
 * Lifecycle shared with reauth via grok-farm-process.
 */

import { broadcast } from "../../ws/index";
import { parseGrokFarmLogLine } from "./log";
import {
  emitGrokProcessLog,
  GrokProcessLatch,
  invalidateGrokCliPool,
  killGrokFarmChild,
  spawnGrokFarmChild,
} from "./process";

export type { GrokFarmLogParse } from "./log";
export { parseGrokFarmLogLine } from "./log";

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

class GrokFarmQueue {
  private status: GrokFarmStatus = createIdleGrokFarmStatus();
  private latch = new GrokProcessLatch();
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
    emitGrokProcessLog(entry);
  }

  async start(opts: {
    count: number;
    concurrent: number;
  }): Promise<{ ok: true; status: GrokFarmStatus } | { ok: false; error: string }> {
    const generation = this.latch.tryAcquire();
    if (generation == null) {
      return { ok: false, error: "Grok farm already running" };
    }

    try {
      const count = Math.max(1, Math.min(1000, Math.floor(opts.count)));
      const concurrent = Math.max(1, Math.min(20, Math.floor(opts.concurrent)));

      this.attemptEmail.clear();
      this.setStatus({
        ...createIdleGrokFarmStatus(),
        running: true,
        target: count,
        concurrent,
        startedAt: new Date().toISOString(),
        lastMessage: "starting http_farm.py",
      });

      const spawned = await spawnGrokFarmChild({
        args: ["-n", String(count), "-c", String(concurrent), "-y", "--push"],
        onLine: (line) => this.handleLine(line),
        onSpawnError: (err) => {
          if (!this.latch.release(generation)) return;
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
        },
        onClose: (code) => {
          if (!this.latch.release(generation)) return;
          invalidateGrokCliPool();
          const ok = code === 0;
          this.setStatus({
            running: false,
            finishedAt: new Date().toISOString(),
            lastMessage: ok ? "farm finished" : `farm exit ${code}`,
            error: ok ? null : `exit ${code}`,
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
          if (ok) {
            broadcast({ type: "grok_farm_complete", data: this.getStatus() });
            if (this.status.success > 0) {
              broadcast({
                type: "accounts_bulk_created",
                data: { count: this.status.success, provider: "grok-cli" },
              });
            }
          } else {
            broadcast({ type: "grok_farm_failed", data: this.getStatus() });
          }
        },
      });

      if (!spawned.ok) {
        this.latch.forceClear();
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
        type: "grok_farm_started",
        step: "start",
        message: `Grok farm started: target=${count} concurrent=${concurrent}`,
        data: { target: count, concurrent },
      });

      broadcast({ type: "grok_farm_started", data: this.getStatus() });
      return { ok: true, status: this.getStatus() };
    } catch (err) {
      this.latch.forceClear();
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus({
        running: false,
        finishedAt: new Date().toISOString(),
        error: message,
      });
      return { ok: false, error: message };
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
        ...(p.pushFailures != null ? { pushFailures: p.pushFailures } : {}),
        lastMessage: line.trim().slice(0, 200),
      });
      this.emitLog({
        type: "grok_farm_progress",
        step: "summary",
        message: `Summary: ${p.success} ok, ${p.failed} fail${
          p.pushFailures != null ? `, ${p.pushFailures} push_fail` : ""
        }`,
        data: {
          success: p.success,
          failed: p.failed,
          pushFailures: p.pushFailures,
        },
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
      this.setStatus({
        lastMessage: `#${p.attempt} ${p.step}${email ? ` ${email}` : ""}`.slice(0, 200),
      });
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
      this.setStatus({
        lastMessage: p.message,
        error: /ERROR/i.test(p.message) ? p.message : this.status.error,
      });
      this.emitLog({
        type: "grok_farm_progress",
        step: "info",
        message: p.message,
        error: /ERROR/i.test(p.message) ? p.message : undefined,
      });
    }
  }

  stop(): { ok: true } | { ok: false; error: string } {
    const child = this.latch.currentChild;
    const killed = killGrokFarmChild(child);
    if (!killed.ok) return killed;

    // Terminal status immediately (same for farm + reauth).
    this.latch.forceClear();
    this.setStatus({
      running: false,
      finishedAt: new Date().toISOString(),
      lastMessage: "stopped by user",
      error: "stopped",
      pid: null,
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
