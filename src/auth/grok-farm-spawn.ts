/**
 * Shared helpers for spawning scripts/grok-farm/http_farm.py
 * (used by farm queue + reauth queue).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config";
import { getActiveApiKey } from "../api/keys";

export type GrokFarmPython = {
  farmDir: string;
  script: string;
  pyBin: string;
  pyArgs: string[];
};

/** Resolve farm dir + http_farm.py + preferred python (venv wins). */
export function resolveGrokFarmPython():
  | { ok: true; value: GrokFarmPython }
  | { ok: false; error: string } {
  const farmDir = config.grokFarmDir;
  const script = path.join(farmDir, "http_farm.py");
  if (!existsSync(script)) {
    return {
      ok: false,
      error: `http_farm.py not found at ${script}. Expected in-tree scripts/grok-farm (or set GROK_FARM_DIR).`,
    };
  }

  const venvWin = path.join(farmDir, ".venv", "Scripts", "python.exe");
  const venvUnix = path.join(farmDir, ".venv", "bin", "python");
  let pyBin = config.grokFarmPython;
  let pyArgs = [...config.grokFarmPythonArgs];
  if (existsSync(venvWin)) {
    pyBin = venvWin;
    pyArgs = [];
  } else if (existsSync(venvUnix)) {
    pyBin = venvUnix;
    pyArgs = [];
  }

  return { ok: true, value: { farmDir, script, pyBin, pyArgs } };
}

/** Active dashboard/DB key preferred over stale env-only config.apiKey. */
export async function resolveGrokFarmApiKey(): Promise<
  { ok: true; apiKey: string; etteumUrl: string } | { ok: false; error: string }
> {
  const apiKey = (await getActiveApiKey()) || config.apiKey;
  if (!apiKey) {
    return { ok: false, error: "API_KEY not set (needed for farm/reauth push to etteum)" };
  }
  const etteumUrl = process.env.ETTEUM_PUBLIC_URL || `http://127.0.0.1:${config.port}`;
  return { ok: true, apiKey, etteumUrl };
}

/** Env injected into http_farm.py so preflight + push use the live key. */
export function grokFarmChildEnv(apiKey: string, etteumUrl: string): NodeJS.ProcessEnv {
  return {
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
  };
}
