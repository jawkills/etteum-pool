/**
 * Load CodeBuddy farm config from settings table → process env map.
 */

import { db } from "../../db/index";
import { settings } from "../../db/schema";

export const CODEBUDDY_FARM_SETTING_KEYS = [
  "codebuddy_farm.hme_url",
  "codebuddy_farm.hme_account",
  "codebuddy_farm.hme_generate_path",
  "codebuddy_farm.captcha_solver_url",
  "codebuddy_farm.di_login",
  "codebuddy_farm.di_password",
  "codebuddy_farm.di_host",
  "codebuddy_farm.di_countries",
  "codebuddy_farm.di_sessttl",
  "codebuddy_farm.default_count",
  "codebuddy_farm.default_concurrent",
  "codebuddy_farm.http_only",
] as const;

export type CodeBuddyFarmSettingKey = (typeof CODEBUDDY_FARM_SETTING_KEYS)[number];

/** Map settings key → child process env var (only runtime farm vars). */
const SETTING_TO_ENV: Partial<Record<CodeBuddyFarmSettingKey, string>> = {
  "codebuddy_farm.hme_url": "ICLOUD_HME_URL",
  "codebuddy_farm.hme_account": "ICLOUD_HME_ACCOUNT",
  "codebuddy_farm.hme_generate_path": "ICLOUD_HME_GENERATE_PATH",
  "codebuddy_farm.captcha_solver_url": "CAPTCHA_SOLVER_URL",
  "codebuddy_farm.di_login": "DI_LOGIN",
  "codebuddy_farm.di_password": "DI_PASSWORD",
  "codebuddy_farm.di_host": "DI_HOST",
  "codebuddy_farm.di_countries": "DI_COUNTRIES",
  "codebuddy_farm.di_sessttl": "DI_SESSTTL",
  "codebuddy_farm.http_only": "CODEBUDDY_HTTP_ONLY",
};

export type CodeBuddyFarmSettingsMap = Partial<Record<CodeBuddyFarmSettingKey, string>>;

export async function loadCodeBuddyFarmSettings(): Promise<CodeBuddyFarmSettingsMap> {
  const rows = await db.select().from(settings);
  const out: CodeBuddyFarmSettingsMap = {};
  const want = new Set<string>(CODEBUDDY_FARM_SETTING_KEYS);
  for (const row of rows) {
    if (!want.has(row.key)) continue;
    if (row.value == null || String(row.value).trim() === "") continue;
    out[row.key as CodeBuddyFarmSettingKey] = String(row.value).trim();
  }
  return out;
}

/** Convert DB settings to env overrides (non-empty only). */
export function codebuddyFarmSettingsToEnv(
  map: CodeBuddyFarmSettingsMap,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [settingKey, envKey] of Object.entries(SETTING_TO_ENV)) {
    const val = map[settingKey as CodeBuddyFarmSettingKey];
    if (val != null && val !== "" && envKey) {
      env[envKey] = val;
    }
  }
  // Always force HME backend when farm settings present
  if (env.ICLOUD_HME_URL || env.DI_LOGIN) {
    env.MAIL_BACKEND = "icloud_hme";
  }
  return env;
}

export function getCodeBuddyFarmUiDefaults(map: CodeBuddyFarmSettingsMap): {
  count: number;
  concurrent: number;
} {
  const count = Math.max(1, Math.min(100, Number(map["codebuddy_farm.default_count"]) || 1));
  const concurrent = Math.max(
    1,
    Math.min(5, Number(map["codebuddy_farm.default_concurrent"]) || 1),
  );
  return { count, concurrent };
}

/** Redact secrets for API responses. */
export function redactCodeBuddyFarmSettings(
  map: CodeBuddyFarmSettingsMap,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const key of CODEBUDDY_FARM_SETTING_KEYS) {
    const v = map[key];
    if (v == null || v === "") continue;
    if (key === "codebuddy_farm.di_password") {
      out[key] = "***";
      out["codebuddy_farm.di_password_set"] = true;
    } else if (key === "codebuddy_farm.di_login") {
      out[key] = v.length <= 4 ? "****" : `${v.slice(0, 2)}***${v.slice(-2)}`;
      out["codebuddy_farm.di_login_set"] = true;
    } else {
      out[key] = v;
    }
  }
  return out;
}
