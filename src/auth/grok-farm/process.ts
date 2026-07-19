/**
 * Shared lifecycle for supervising scripts/grok-farm/http_farm.py.
 * Used by farm + reauth job modules (single startLock/child/line-buffer/stop path).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { broadcast } from "../../ws/index";
import { pool } from "../../proxy/pool";
import type { ProviderName } from "../../proxy/pool";
import { addAuthLog } from "../logs";
import {
  grokFarmChildEnv,
  resolveGrokFarmApiKey,
  resolveGrokFarmPython,
  type GrokFarmPython,
} from "./spawn";

const GROK_PROVIDER: ProviderName = "grok-cli";

export type GrokProcessLogEntry = {
  type: string;
  email?: string;
  step?: string;
  message?: string;
  error?: string;
  data?: unknown;
};

export type SpawnGrokFarmChildOpts = {
  /** Extra argv after python + script (e.g. -n 5 -c 2 -y --push). */
  args: string[];
  /** Called for each complete stdout/stderr line. */
  onLine: (line: string) => void;
  onSpawnError: (err: Error) => void;
  onClose: (code: number | null) => void;
};

export type SpawnGrokFarmChildResult =
  | { ok: true; child: ChildProcess; py: GrokFarmPython; apiKey: string; etteumUrl: string }
  | { ok: false; error: string };

/** Resolve python + API key and spawn http_farm.py with shared env. */
export async function spawnGrokFarmChild(
  opts: SpawnGrokFarmChildOpts
): Promise<SpawnGrokFarmChildResult> {
  const py = resolveGrokFarmPython();
  if (!py.ok) return { ok: false, error: py.error };

  const key = await resolveGrokFarmApiKey();
  if (!key.ok) return { ok: false, error: key.error };

  const { farmDir, script, pyBin, pyArgs } = py.value;
  const { apiKey, etteumUrl } = key;

  const child = spawn(pyBin, [...pyArgs, script, ...opts.args], {
    cwd: farmDir,
    env: grokFarmChildEnv(apiKey, etteumUrl),
    windowsHide: true,
  });

  let buf = "";
  const onData = (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || "";
    for (const line of lines) opts.onLine(line);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  child.on("error", (err) => opts.onSpawnError(err));
  child.on("close", (code) => opts.onClose(code));

  return { ok: true, child, py: py.value, apiKey, etteumUrl };
}

/** Auth-log + WS fanout for farm/reauth events. */
export function emitGrokProcessLog(entry: GrokProcessLogEntry): void {
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

/** Invalidate grok-cli pool after job end (typed, no `as any`). */
export function invalidateGrokCliPool(): void {
  pool.invalidate(GROK_PROVIDER);
}

/**
 * Kill child and mark terminal immediately (shared stop semantics).
 * Close handler must still clear startLock / cleanup; generation token
 * prevents late close from resurrecting a user-stopped job.
 */
export function killGrokFarmChild(child: ChildProcess | null): { ok: true } | { ok: false; error: string } {
  if (!child) return { ok: false, error: "No process running" };
  try {
    child.kill();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true };
}

/**
 * Latch helper: claim start or reject if already running.
 * Caller must release via clearStartLock on all exit paths.
 */
export class GrokProcessLatch {
  private locked = false;
  private generation = 0;
  private child: ChildProcess | null = null;

  get isBusy(): boolean {
    return this.locked || this.child != null;
  }

  get currentChild(): ChildProcess | null {
    return this.child;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  /** Returns generation on success; null if busy. */
  tryAcquire(): number | null {
    if (this.locked || this.child) return null;
    this.locked = true;
    this.generation += 1;
    return this.generation;
  }

  setChild(child: ChildProcess | null): void {
    this.child = child;
  }

  /**
   * Clear latch if generation still matches (ignore stale close after stop/restart).
   * Returns true if this generation still owns the latch.
   */
  release(generation: number): boolean {
    if (generation !== this.generation) return false;
    this.locked = false;
    this.child = null;
    return true;
  }

  /**
 * Force clear latch and bump generation so in-flight close/error handlers
 * with the old generation are ignored (user stop / pre-child failure).
 */
  forceClear(): void {
    this.locked = false;
    this.child = null;
    this.generation += 1;
  }
}
