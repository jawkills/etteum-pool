/**
 * Grok CLI runtime settings — settings table with short TTL cache.
 * Keys (optional; defaults match previous hardcodes):
 *   grok_cli_refresh_lead_sec   int seconds (default 2700 = 45m)
 *   grok_cli_max_account_retries int attempts per request (default 8)
 *
 * Hot path reads cache sync. First miss kicks a background DB load so
 * operator knobs survive process restart without waiting for Settings PUT.
 */

import { db } from "../../../db/index";
import { settings } from "../../../db/schema";
import { like } from "drizzle-orm";

const TTL_MS = 10_000;

// Single default source for lead seconds (env override allowed).
export const DEFAULT_GROK_CLI_REFRESH_LEAD_SEC =
  Number(process.env.GROK_CLI_REFRESH_LEAD_SEC) || 45 * 60;
export const DEFAULT_GROK_CLI_MAX_ACCOUNT_RETRIES = 8;

export type GrokCliRuntimeSettings = {
  refreshLeadSec: number;
  maxAccountRetries: number;
};

export const DEFAULT_GROK_CLI_RUNTIME: GrokCliRuntimeSettings = {
  refreshLeadSec: DEFAULT_GROK_CLI_REFRESH_LEAD_SEC,
  maxAccountRetries: DEFAULT_GROK_CLI_MAX_ACCOUNT_RETRIES,
};

let cache: { value: GrokCliRuntimeSettings; loadedAt: number } | null = null;
let loadInFlight: Promise<GrokCliRuntimeSettings> | null = null;

function parseInt10(
  v: string | null | undefined,
  dflt: number,
  min: number,
  max: number,
): number {
  if (v == null) return dflt;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

async function loadFromDb(): Promise<GrokCliRuntimeSettings> {
  const rows = await db.select().from(settings).where(like(settings.key, "grok_cli_%"));
  const map = new Map<string, string | null>();
  for (const r of rows) map.set(r.key, r.value);

  return {
    refreshLeadSec: parseInt10(
      map.get("grok_cli_refresh_lead_sec"),
      DEFAULT_GROK_CLI_RUNTIME.refreshLeadSec,
      60,
      24 * 60 * 60,
    ),
    maxAccountRetries: parseInt10(
      map.get("grok_cli_max_account_retries"),
      DEFAULT_GROK_CLI_RUNTIME.maxAccountRetries,
      1,
      50,
    ),
  };
}

export async function getGrokCliRuntimeSettings(): Promise<GrokCliRuntimeSettings> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < TTL_MS) return cache.value;
  if (loadInFlight) return loadInFlight;

  loadInFlight = (async () => {
    try {
      const value = await loadFromDb();
      cache = { value, loadedAt: Date.now() };
      return value;
    } catch (err) {
      console.error("[GrokCliSettings] Failed to load, using defaults:", err);
      // Cache defaults briefly so we don't hammer DB on repeated failures.
      cache = { value: DEFAULT_GROK_CLI_RUNTIME, loadedAt: Date.now() };
      return DEFAULT_GROK_CLI_RUNTIME;
    } finally {
      loadInFlight = null;
    }
  })();

  return loadInFlight;
}

/**
 * Sync snapshot for hot path.
 * - Returns cache when present.
 * - On cold cache, returns defaults immediately and warms from DB in background
 *   so Settings survive restart without requiring a Settings PUT.
 */
export function getCachedGrokCliRuntimeSettings(): GrokCliRuntimeSettings {
  if (!cache) {
    void getGrokCliRuntimeSettings();
    return DEFAULT_GROK_CLI_RUNTIME;
  }
  // Refresh in background when TTL expired (still serve last value).
  if (Date.now() - cache.loadedAt >= TTL_MS) {
    void getGrokCliRuntimeSettings();
  }
  return cache.value;
}

export function invalidateGrokCliSettingsCache(): void {
  cache = null;
  loadInFlight = null;
}

export function isGrokCliSettingKey(key: string): boolean {
  return key.startsWith("grok_cli_");
}
