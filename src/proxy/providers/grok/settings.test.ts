import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GROK_RUNTIME,
  DEFAULT_GROK_REFRESH_LEAD_SEC,
  getCachedGrokRuntimeSettings,
  invalidateGrokSettingsCache,
  isGrokSettingKey,
} from "./settings";
import { GROK_REFRESH_LEAD_SEC, grokProvider } from "./index";

describe("grok-cli-settings", () => {
  test("defaults match prior hardcodes and single lead source", () => {
    invalidateGrokSettingsCache();
    const s = getCachedGrokRuntimeSettings();
    expect(s.refreshLeadSec).toBe(DEFAULT_GROK_RUNTIME.refreshLeadSec);
    expect(s.maxAccountRetries).toBe(8);
    expect(s.refreshLeadSec).toBeGreaterThanOrEqual(60);
    expect(GROK_REFRESH_LEAD_SEC).toBe(DEFAULT_GROK_REFRESH_LEAD_SEC);
  });

  test("isGrokSettingKey only matches grok_cli_ prefix", () => {
    expect(isGrokSettingKey("grok_refresh_lead_sec")).toBe(true);
    expect(isGrokSettingKey("grok_cli_refresh_lead_sec")).toBe(true);
    expect(isGrokSettingKey("grok_max_account_retries")).toBe(true);
    expect(isGrokSettingKey("grok_cli_max_account_retries")).toBe(true);
    expect(isGrokSettingKey("compression_rtk_enabled")).toBe(false);
    expect(isGrokSettingKey("provider_grok_lb_method")).toBe(false);
  });

  test("maxAccountRetries is live cache read (no dual-store apply)", () => {
    invalidateGrokSettingsCache();
    // Cold cache returns defaults immediately while background load starts.
    expect(grokProvider.maxAccountRetries).toBe(
      DEFAULT_GROK_RUNTIME.maxAccountRetries,
    );
    expect(getCachedGrokRuntimeSettings().maxAccountRetries).toBe(
      grokProvider.maxAccountRetries,
    );
  });
});
