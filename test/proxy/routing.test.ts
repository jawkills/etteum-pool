import { describe, expect, test } from "bun:test";
import { pool } from "../../src/proxy/pool";
import { providers } from "../../src/proxy/providers/registry";

/**
 * Characterization test for model → provider routing.
 *
 * This locks the CURRENT behavior of getProviderForModel so the registry/ownsModel
 * refactor (Fase 1) can be proven behavior-identical. If you add or change a
 * provider's model patterns, update the matching case here on purpose — a failure
 * means routing for some OTHER provider shifted unintentionally.
 */
describe("getProviderForModel", () => {
  const cases: Array<[string, string]> = [
    // canva
    ["canva-image", "canva"],
    ["CANVA-IMAGE", "canva"],
    // qoder
    ["qd-Lite", "qoder"],
    ["qd-Qwen3.7-Max", "qoder"],
    // codex (must win over codebuddy for gpt-5-codex)
    ["codex-mini", "codex"],
    ["codex-gpt-5.5-xhigh", "codex"],
    ["gpt-5-codex", "codex"],
    ["gpt-5.5-xhigh", "codex"],
    // kiro-pro
    ["kp-opus-4.8", "kiro-pro"],
    ["kp-sonnet-4.6-thinking", "kiro-pro"],
    // codebuddy (cb- prefix only — unprefixed gpt/gemini route elsewhere or to kiro)
    ["cb-opus-4.6", "codebuddy"],
    ["cb-opus-4.7-1m", "codebuddy"],
    ["cb-gpt-5.6-sol", "codebuddy"],
    ["cb-gpt-5.5", "codebuddy"],
    ["cb-gemini-2.5-pro", "codebuddy"],
    ["cb-deepseek-v3", "codebuddy"],
    ["cb-kimi-k2.6", "codebuddy"],
    ["cb-glm-5.2", "codebuddy"],
    ["cb-minimax-m3", "codebuddy"],
    ["cb-o3", "codebuddy"],
    // kiro (standard)
    ["auto", "kiro"],
    ["claude-haiku-4.5", "kiro"],
    ["claude-sonnet-4", "kiro"],
    ["claude-sonnet-4.5", "kiro"],
    ["claude-sonnet-4.5-thinking", "kiro"],
    ["deepseek-3.2", "kiro"],
    ["glm-5", "kiro"],
    ["glm-5-thinking", "kiro"],
    ["minimax-m2.1", "kiro"],
    ["qwen3-coder-next", "kiro"],
    // claude fallback → kiro
    ["claude-opus-4.1", "kiro"],
    ["some-unknown-sonnet-model", "kiro"],
    // unknown default → kiro
    ["totally-unknown-model", "kiro"],
  ];

  for (const [model, expected] of cases) {
    test(`${model} → ${expected}`, () => {
      expect(pool.getProviderForModel(model) as string | null).toBe(expected);
    });
  }

  test("never routes to a removed provider (moclaw/zai/windsurf/pioneer)", () => {
    const removed = new Set(["moclaw", "zai", "windsurf", "pioneer"]);
    for (const m of ["ws-claude-4.5-sonnet", "zai-glm", "pio-default", "mo-auto", "moclaw-x"]) {
      expect(removed.has(pool.getProviderForModel(m) as string)).toBe(false);
    }
  });

  test("codex gpt-5.5-xhigh alias uses codex metadata", () => {
    expect(providers.codex.getModelInfo("gpt-5.5-xhigh")?.id).toBe("codex-gpt-5.5-xhigh");
    expect(providers.codex.getModelInfo("codex-gpt-5.5-xhigh")?.id).toBe("codex-gpt-5.5-xhigh");
    expect(providers.codex.getProviderCreditUnit("gpt-5.5-xhigh")).toBe("credit");
  });
});
