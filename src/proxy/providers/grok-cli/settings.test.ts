import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GROK_CLI_RUNTIME,
  DEFAULT_GROK_CLI_REFRESH_LEAD_SEC,
  getCachedGrokCliRuntimeSettings,
  invalidateGrokCliSettingsCache,
  isGrokCliSettingKey,
} from "./settings";
import { GROK_CLI_REFRESH_LEAD_SEC, grokCliProvider } from "./index";

describe("grok-cli-settings", () => {
  test("defaults match prior hardcodes and single lead source", () => {
    invalidateGrokCliSettingsCache();
    const s = getCachedGrokCliRuntimeSettings();
    expect(s.refreshLeadSec).toBe(DEFAULT_GROK_CLI_RUNTIME.refreshLeadSec);
    expect(s.maxAccountRetries).toBe(8);
    expect(s.refreshLeadSec).toBeGreaterThanOrEqual(60);
    expect(GROK_CLI_REFRESH_LEAD_SEC).toBe(DEFAULT_GROK_CLI_REFRESH_LEAD_SEC);
  });

  test("isGrokCliSettingKey only matches grok_cli_ prefix", () => {
    expect(isGrokCliSettingKey("grok_cli_refresh_lead_sec")).toBe(true);
    expect(isGrokCliSettingKey("grok_cli_max_account_retries")).toBe(true);
    expect(isGrokCliSettingKey("compression_rtk_enabled")).toBe(false);
    expect(isGrokCliSettingKey("provider_grok-cli_lb_method")).toBe(false);
  });

  test("maxAccountRetries is live cache read (no dual-store apply)", () => {
    invalidateGrokCliSettingsCache();
    // Cold cache returns defaults immediately while background load starts.
    expect(grokCliProvider.maxAccountRetries).toBe(
      DEFAULT_GROK_CLI_RUNTIME.maxAccountRetries,
    );
    expect(getCachedGrokCliRuntimeSettings().maxAccountRetries).toBe(
      grokCliProvider.maxAccountRetries,
    );
  });
});
