/**
 * Shared lifecycle for supervising scripts/codebuddy-farm/http_farm.py
 */

import { spawn, type ChildProcess } from "node:child_process";
import { broadcast } from "../../ws/index";
import { pool } from "../../proxy/pool";
import type { ProviderName } from "../../proxy/pool";
import { addAuthLog } from "../logs";
import {
  buildCodeBuddyFarmChildEnv,
  resolveCodeBuddyFarmApiKey,
  resolveCodeBuddyFarmPython,
  type CodeBuddyFarmPython,
} from "./spawn";

const PROVIDER: ProviderName = "codebuddy";

export type CodeBuddyProcessLogEntry = {
  type: string;
  email?: string;
  step?: string;
  message?: string;
  error?: string;
  data?: unknown;
};

export type SpawnCodeBuddyFarmChildOpts = {
  args: string[];
  onLine: (line: string) => void;
  onSpawnError: (err: Error) => void;
  onClose: (code: number | null) => void;
};

export type SpawnCodeBuddyFarmChildResult =
  | {
      ok: true;
      child: ChildProcess;
      py: CodeBuddyFarmPython;
      apiKey: string;
      etteumUrl: string;
    }
  | { ok: false; error: string };

export async function spawnCodeBuddyFarmChild(
  opts: SpawnCodeBuddyFarmChildOpts,
): Promise<SpawnCodeBuddyFarmChildResult> {
  const py = resolveCodeBuddyFarmPython();
  if (!py.ok) return { ok: false, error: py.error };

  const key = await resolveCodeBuddyFarmApiKey();
  if (!key.ok) return { ok: false, error: key.error };

  const { farmDir, script, pyBin, pyArgs } = py.value;
  const { apiKey, etteumUrl } = key;
  const childEnv = await buildCodeBuddyFarmChildEnv(apiKey, etteumUrl);

  const child = spawn(pyBin, [...pyArgs, script, ...opts.args], {
    cwd: farmDir,
    env: childEnv,
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

export function emitCodeBuddyProcessLog(entry: CodeBuddyProcessLogEntry): void {
  const log = addAuthLog({
    provider: "codebuddy",
    ...entry,
  });
  broadcast({
    type: entry.type,
    data: {
      logId: log.id,
      timestamp: log.timestamp,
      type: entry.type,
      provider: "codebuddy",
      email: entry.email || log.email,
      step: entry.step || log.step,
      message: entry.message || log.message,
      error: entry.error || log.error,
      data: entry.data,
    },
  });
}

export function invalidateCodeBuddyPool(): void {
  pool.invalidate(PROVIDER);
}

export function killCodeBuddyFarmChild(
  child: ChildProcess | null,
): { ok: true } | { ok: false; error: string } {
  if (!child) return { ok: false, error: "No process running" };
  try {
    child.kill();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true };
}

export class CodeBuddyProcessLatch {
  private locked = false;
  private generation = 0;
  private child: ChildProcess | null = null;

  get isBusy(): boolean {
    return this.locked || this.child != null;
  }

  get currentChild(): ChildProcess | null {
    return this.child;
  }

  tryAcquire(): number | null {
    if (this.locked || this.child) return null;
    this.locked = true;
    this.generation += 1;
    return this.generation;
  }

  setChild(child: ChildProcess | null): void {
    this.child = child;
  }

  release(generation: number): boolean {
    if (generation !== this.generation) return false;
    this.locked = false;
    this.child = null;
    return true;
  }

  forceClear(): void {
    this.locked = false;
    this.child = null;
    this.generation += 1;
  }
}
