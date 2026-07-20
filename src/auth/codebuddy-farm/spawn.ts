/**
 * Spawn helpers for scripts/codebuddy-farm/http_farm.py
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../../config";
import { getActiveApiKey } from "../../api/keys";
import {
  codebuddyFarmSettingsToEnv,
  loadCodeBuddyFarmSettings,
} from "./settings";

export type CodeBuddyFarmPython = {
  farmDir: string;
  script: string;
  pyBin: string;
  pyArgs: string[];
};

export function resolveCodeBuddyFarmPython():
  | { ok: true; value: CodeBuddyFarmPython }
  | { ok: false; error: string } {
  const farmDir = config.codebuddyFarmDir;
  const script = path.join(farmDir, "http_farm.py");
  if (!existsSync(script)) {
    return {
      ok: false,
      error: `http_farm.py not found at ${script}. Expected in-tree scripts/codebuddy-farm (or set CODEBUDDY_FARM_DIR).`,
    };
  }

  const venvWin = path.join(farmDir, ".venv", "Scripts", "python.exe");
  const venvUnix = path.join(farmDir, ".venv", "bin", "python");
  let pyBin = config.codebuddyFarmPython;
  let pyArgs = [...config.codebuddyFarmPythonArgs];
  if (existsSync(venvWin)) {
    pyBin = venvWin;
    pyArgs = [];
  } else if (existsSync(venvUnix)) {
    pyBin = venvUnix;
    pyArgs = [];
  }

  return { ok: true, value: { farmDir, script, pyBin, pyArgs } };
}

export async function resolveCodeBuddyFarmApiKey(): Promise<
  { ok: true; apiKey: string; etteumUrl: string } | { ok: false; error: string }
> {
  const apiKey = (await getActiveApiKey()) || config.apiKey;
  if (!apiKey) {
    return { ok: false, error: "API_KEY not set (needed for farm push to etteum)" };
  }
  const etteumUrl = process.env.ETTEUM_PUBLIC_URL || `http://127.0.0.1:${config.port}`;
  return { ok: true, apiKey, etteumUrl };
}

export function codebuddyFarmChildEnv(
  apiKey: string,
  etteumUrl: string,
  settingsEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Dashboard/DB settings override process.env and farm .env (Python load_dotenv override=False)
    ...settingsEnv,
    ETTEUM_URL: etteumUrl,
    ETTEUM_API_KEY: apiKey,
    API_KEY: apiKey,
    CODEBUDDY_PUSH_ETTEUM: "true",
    CODEBUDDY_PUSH_MODE: "per_success",
    CODEBUDDY_HTTP_ONLY: settingsEnv.CODEBUDDY_HTTP_ONLY || "true",
    CODEBUDDY_UI: "log",
    CODEBUDDY_VERBOSE: "true",
    MAIL_BACKEND: settingsEnv.MAIL_BACKEND || process.env.MAIL_BACKEND || "icloud_hme",
    PYTHONUNBUFFERED: "1",
  };
}

/** Resolve settings from DB then build child env. */
export async function buildCodeBuddyFarmChildEnv(
  apiKey: string,
  etteumUrl: string,
): Promise<NodeJS.ProcessEnv> {
  const map = await loadCodeBuddyFarmSettings();
  const settingsEnv = codebuddyFarmSettingsToEnv(map);
  return codebuddyFarmChildEnv(apiKey, etteumUrl, settingsEnv);
}
