/**
 * Grok runtime settings — settings table with short TTL cache.
 *
 * Keys:
 *   grok_refresh_lead_sec        int seconds (default 2700 = 45m)
 *   grok_max_account_retries     int attempts per request (default 8)
 *   grok_auto_web_search         "true"|"false" (default true)
 *   grok_auto_x_search           "true"|"false" (default true)
 *   grok_auto_code_interpreter   "true"|"false" (default false)
 */

import { db } from "../../../db/index";
import { settings } from "../../../db/schema";
import { like } from "drizzle-orm";

const TTL_MS = 10_000;

export const DEFAULT_GROK_REFRESH_LEAD_SEC =
  Number(process.env.GROK_REFRESH_LEAD_SEC || process.env.GROK_CLI_REFRESH_LEAD_SEC) || 45 * 60;
export const DEFAULT_GROK_MAX_ACCOUNT_RETRIES = 8;

export type GrokRuntimeSettings = {
  refreshLeadSec: number;
  maxAccountRetries: number;
  autoWebSearch: boolean;
  autoXSearch: boolean;
  autoCodeInterpreter: boolean;
};

export const DEFAULT_GROK_RUNTIME: GrokRuntimeSettings = {
  refreshLeadSec: DEFAULT_GROK_REFRESH_LEAD_SEC,
  maxAccountRetries: DEFAULT_GROK_MAX_ACCOUNT_RETRIES,
  autoWebSearch: true,
  autoXSearch: true,
  autoCodeInterpreter: false,
};

let cache: { value: GrokRuntimeSettings; loadedAt: number } | null = null;
let loadInFlight: Promise<GrokRuntimeSettings> | null = null;

function parseInt10(
  v: string | null | undefined,
  dflt: number,
  min: number,
  max: number
): number {
  if (v == null) return dflt;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function parseBool(v: string | null | undefined, dflt: boolean): boolean {
  if (v == null || v === "") return dflt;
  const s = String(v).trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return dflt;
}

async function loadFromDb(): Promise<GrokRuntimeSettings> {
  const rows = await db.select().from(settings).where(like(settings.key, "grok_%"));
  const map = new Map<string, string | null>();
  for (const r of rows) map.set(r.key, r.value);

  return {
    refreshLeadSec: parseInt10(
      map.get("grok_refresh_lead_sec") ?? map.get("grok_cli_refresh_lead_sec"),
      DEFAULT_GROK_RUNTIME.refreshLeadSec,
      60,
      24 * 60 * 60
    ),
    maxAccountRetries: parseInt10(
      map.get("grok_max_account_retries") ?? map.get("grok_cli_max_account_retries"),
      DEFAULT_GROK_RUNTIME.maxAccountRetries,
      1,
      50
    ),
    autoWebSearch: parseBool(map.get("grok_auto_web_search"), DEFAULT_GROK_RUNTIME.autoWebSearch),
    autoXSearch: parseBool(map.get("grok_auto_x_search"), DEFAULT_GROK_RUNTIME.autoXSearch),
    autoCodeInterpreter: parseBool(
      map.get("grok_auto_code_interpreter"),
      DEFAULT_GROK_RUNTIME.autoCodeInterpreter
    ),
  };
}

export async function getGrokRuntimeSettings(): Promise<GrokRuntimeSettings> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < TTL_MS) return cache.value;
  if (loadInFlight) return loadInFlight;

  loadInFlight = (async () => {
    try {
      const value = await loadFromDb();
      cache = { value, loadedAt: Date.now() };
      return value;
    } catch (err) {
      console.error("[GrokSettings] Failed to load, using defaults:", err);
      cache = { value: DEFAULT_GROK_RUNTIME, loadedAt: Date.now() };
      return DEFAULT_GROK_RUNTIME;
    } finally {
      loadInFlight = null;
    }
  })();

  return loadInFlight;
}

/**
 * Sync snapshot for hot path.
 * Cold cache returns defaults immediately and warms from DB in background.
 */
export function getCachedGrokRuntimeSettings(): GrokRuntimeSettings {
  if (!cache) {
    void getGrokRuntimeSettings();
    return DEFAULT_GROK_RUNTIME;
  }
  if (Date.now() - cache.loadedAt >= TTL_MS) {
    void getGrokRuntimeSettings();
  }
  return cache.value;
}

export function invalidateGrokSettingsCache(): void {
  cache = null;
  loadInFlight = null;
}

export function isGrokSettingKey(key: string): boolean {
  return key.startsWith("grok_") || key.startsWith("grok_cli_");
}

// --- deprecated aliases (call sites during transition) ---
/** @deprecated use DEFAULT_GROK_REFRESH_LEAD_SEC */
export const DEFAULT_GROK_CLI_REFRESH_LEAD_SEC = DEFAULT_GROK_REFRESH_LEAD_SEC;
/** @deprecated */
export const DEFAULT_GROK_CLI_MAX_ACCOUNT_RETRIES = DEFAULT_GROK_MAX_ACCOUNT_RETRIES;
/** @deprecated */
export type GrokCliRuntimeSettings = GrokRuntimeSettings;
/** @deprecated */
export const DEFAULT_GROK_CLI_RUNTIME = DEFAULT_GROK_RUNTIME;
/** @deprecated */
export const getGrokCliRuntimeSettings = getGrokRuntimeSettings;
/** @deprecated */
export const getCachedGrokCliRuntimeSettings = getCachedGrokRuntimeSettings;
/** @deprecated */
export const invalidateGrokCliSettingsCache = invalidateGrokSettingsCache;
/** @deprecated */
export const isGrokCliSettingKey = isGrokSettingKey;
