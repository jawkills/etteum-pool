import { describe, expect, test } from "bun:test";
import {
  normalizeGrokCliCpa,
  grokCliOwnsModel,
  buildGrokCliHeaders,
  classifyGrokCliError,
  isGrokCliDeadError,
  parseGrokCliModelId,
  resolveGrokCliUpstreamModel,
  extractGrokCliImageGenerationResults,
  normalizeGrokCliImageRef,
  collectGrokCliImageRefs,
  normalizeGrokCliUsage,
  stripGrokCliDataUrlPrefix,
  GROK_CLI_TOKEN_LIMIT,
  GROK_CLI_CATALOG_IDS,
} from "./grok-cli";

describe("normalizeGrokCliCpa", () => {
  test("accepts flat CPA", () => {
    const out = normalizeGrokCliCpa({
      email: "a@x.com",
      access_token: "at",
      refresh_token: "rt",
      id_token: "idt",
    });
    expect(out.email).toBe("a@x.com");
    expect(out.access_token).toBe("at");
    expect(out.refresh_token).toBe("rt");
  });

  test("accepts nested tokens harvest format", () => {
    const out = normalizeGrokCliCpa({
      email: "b@x.com",
      tokens: { access_token: "at2", refresh_token: "rt2", id_token: "id2" },
    });
    expect(out.access_token).toBe("at2");
    expect(out.refresh_token).toBe("rt2");
  });

  test("accepts camelCase keys", () => {
    const out = normalizeGrokCliCpa({
      email: "c@x.com",
      accessToken: "at3",
      refreshToken: "rt3",
    });
    expect(out.access_token).toBe("at3");
    expect(out.refresh_token).toBe("rt3");
  });

  test("throws when tokens missing", () => {
    expect(() => normalizeGrokCliCpa({ email: "x@x.com" })).toThrow(/access_token/);
  });

  test("extracts team_id/sub from id_token JWT payload when present", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "user-1", team_id: "team-9" })).toString("base64url");
    const idToken = `aaa.${payload}.bbb`;
    const out = normalizeGrokCliCpa({
      email: "d@x.com",
      access_token: "at",
      refresh_token: "rt",
      id_token: idToken,
    });
    expect(out.sub).toBe("user-1");
    expect(out.team_id).toBe("team-9");
  });
});

describe("grokCliOwnsModel", () => {
  test("owns gcli catalog ids", () => {
    expect(grokCliOwnsModel("gcli/grok-4.5")).toBe(true);
    expect(grokCliOwnsModel("gcli/grok-4.5-high")).toBe(true);
    expect(grokCliOwnsModel("gcli/grok-4.5-medium")).toBe(true);
    expect(grokCliOwnsModel("gcli/grok-4.5-low")).toBe(true);
  });
  test("owns bare grok-4.5 compat", () => {
    expect(grokCliOwnsModel("grok-4.5")).toBe(true);
  });
  test("owns prefixed grok-cli-grok-4.5", () => {
    expect(grokCliOwnsModel("grok-cli-grok-4.5")).toBe(true);
  });
  test("does not own claude/gpt ids", () => {
    expect(grokCliOwnsModel("claude-sonnet-4.6")).toBe(false);
    expect(grokCliOwnsModel("gpt-4o")).toBe(false);
  });
});

describe("parseGrokCliModelId", () => {
  test("maps gcli effort aliases to grok-4.5 + effort", () => {
    expect(parseGrokCliModelId("gcli/grok-4.5")).toEqual({
      upstream: "grok-4.5",
      effort: null,
      bare: "grok-4.5",
    });
    expect(parseGrokCliModelId("gcli/grok-4.5-high").effort).toBe("high");
    expect(parseGrokCliModelId("gcli/grok-4.5-medium").effort).toBe("medium");
    expect(parseGrokCliModelId("gcli/grok-4.5-low").effort).toBe("low");
    expect(resolveGrokCliUpstreamModel("gcli/grok-4.5-high")).toBe("grok-4.5");
  });
  test("catalog has 4 models", () => {
    expect(GROK_CLI_CATALOG_IDS).toHaveLength(4);
  });
});

describe("buildGrokCliHeaders", () => {
  test("includes required CLI auth headers and model override", () => {
    const h = buildGrokCliHeaders(
      {
        access_token: "tok",
        email: "a@x.com",
        team_id: "t1",
        sub: "u1",
      },
      "grok-4.5"
    );
    expect(h.Authorization).toBe("Bearer tok");
    // single auth header only — Bun merges duplicate case variants into comma list
    expect(h["x-xai-token-auth"]).toBe("xai-grok-cli");
    expect(h["X-XAI-Token-Auth"]).toBeUndefined();
    expect(h["x-grok-model-override"]).toBe("grok-4.5");
    expect(h["x-email"]).toBe("a@x.com");
    expect(h["x-teamid"]).toBe("t1");
    expect(h["x-userid"]).toBe("u1");
  });
});

describe("classifyGrokCliError", () => {
  test("403 spending limit => exhausted", () => {
    expect(classifyGrokCliError(403, "credits are exhausted")).toBe("exhausted");
  });
  test("401 revoked => dead", () => {
    expect(classifyGrokCliError(401, "invalid_grant revoked")).toBe("dead");
  });
  test("401 generic => auth", () => {
    expect(classifyGrokCliError(401, "unauthorized")).toBe("auth");
  });
  test("other => null", () => {
    expect(classifyGrokCliError(500, "boom")).toBe(null);
  });
});

describe("isGrokCliDeadError", () => {
  test("matches invalid_grant / revoked / Grok CLI dead prefix", () => {
    expect(isGrokCliDeadError('invalid_grant: {"error":"invalid_grant"}')).toBe(true);
    expect(isGrokCliDeadError("Refresh token has been revoked")).toBe(true);
    expect(isGrokCliDeadError("Grok CLI dead: invalid_grant")).toBe(true);
    // Missing credentials are unusable for traffic (dead) but not permanent IdP death.
    expect(isGrokCliDeadError("No access_token for grok-cli account")).toBe(true);
  });
  test("does not match generic auth/network", () => {
    expect(isGrokCliDeadError("Grok CLI auth: unauthorized")).toBe(false);
    expect(isGrokCliDeadError("timeout")).toBe(false);
    expect(isGrokCliDeadError(null)).toBe(false);
  });
  test("missing credentials stay non-permanent (WarmUp must not latch)", async () => {
    const { isPermanentRevocation, isMissingCredentialMessage } = await import(
      "../account-health"
    );
    const msg = "No access_token for grok-cli account";
    expect(isGrokCliDeadError(msg)).toBe(true);
    expect(isMissingCredentialMessage(msg)).toBe(true);
    expect(isPermanentRevocation(msg)).toBe(false);
    // The permanent latch string itself must only match real IdP death.
    expect(isPermanentRevocation("Grok CLI dead: invalid_grant")).toBe(true);
    expect(isPermanentRevocation(msg)).toBe(false);
  });
});

describe("constants", () => {
  test("token limit is 2M", () => {
    expect(GROK_CLI_TOKEN_LIMIT).toBe(2_000_000);
  });
});

describe("image helpers", () => {
  test("stripGrokCliDataUrlPrefix removes data URL wrapper", () => {
    expect(stripGrokCliDataUrlPrefix("data:image/png;base64,abc123")).toBe("abc123");
    expect(stripGrokCliDataUrlPrefix("abc123")).toBe("abc123");
  });

  test("normalizeGrokCliImageRef handles bare b64, data URL, https", () => {
    expect(normalizeGrokCliImageRef("aGVsbG8=")).toBe("data:image/png;base64,aGVsbG8=");
    expect(normalizeGrokCliImageRef("data:image/jpeg;base64,/9j/xx")).toBe("data:image/jpeg;base64,/9j/xx");
    expect(normalizeGrokCliImageRef("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(normalizeGrokCliImageRef({ b64_json: "zzz" })).toBe("data:image/png;base64,zzz");
    expect(normalizeGrokCliImageRef(null)).toBe(null);
  });

  test("collectGrokCliImageRefs gathers image/images and caps", () => {
    const refs = collectGrokCliImageRefs(
      {
        image: "aaa",
        images: ["bbb", "ccc", "ddd", "eee"],
      },
      3
    );
    // images array is collected first, then image — cap 3
    expect(refs).toHaveLength(3);
  });

  test("extractGrokCliImageGenerationResults reads image_generation_call", () => {
    const payload = {
      output: [
        { type: "reasoning", content: [] },
        { type: "image_generation_call", result: "data:image/jpeg;base64,/9j/4AAQ" },
        { type: "image_generation_call", result: { b64_json: "qqq" } },
      ],
    };
    expect(extractGrokCliImageGenerationResults(payload)).toEqual(["/9j/4AAQ", "qqq"]);
  });

  test("normalizeGrokCliUsage maps input/output aliases", () => {
    expect(normalizeGrokCliUsage({ input_tokens: 10, output_tokens: 20 })).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      input_tokens: 10,
      output_tokens: 20,
    });
  });

  test("owns gcli/grok-image", () => {
    expect(grokCliOwnsModel("gcli/grok-image")).toBe(true);
  });
});
