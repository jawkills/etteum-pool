import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GROK_CLI_RUNTIME,
  getCachedGrokCliRuntimeSettings,
  invalidateGrokCliSettingsCache,
  isGrokCliSettingKey,
} from "./grok-cli-settings";

describe("grok-cli-settings", () => {
  test("defaults match prior hardcodes", () => {
    invalidateGrokCliSettingsCache();
    const s = getCachedGrokCliRuntimeSettings();
    expect(s.refreshLeadSec).toBe(DEFAULT_GROK_CLI_RUNTIME.refreshLeadSec);
    expect(s.maxAccountRetries).toBe(8);
    expect(s.refreshLeadSec).toBeGreaterThanOrEqual(60);
  });

  test("isGrokCliSettingKey only matches grok_cli_ prefix", () => {
    expect(isGrokCliSettingKey("grok_cli_refresh_lead_sec")).toBe(true);
    expect(isGrokCliSettingKey("grok_cli_max_account_retries")).toBe(true);
    expect(isGrokCliSettingKey("compression_rtk_enabled")).toBe(false);
    expect(isGrokCliSettingKey("provider_grok-cli_lb_method")).toBe(false);
  });
});
