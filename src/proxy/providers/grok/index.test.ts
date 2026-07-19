import { describe, expect, test } from "bun:test";
import {
  normalizeGrokCliCpa,
  grokCliOwnsModel,
  buildGrokCliHeaders,
  classifyGrokCliError,
  isGrokCliDeadError,
  classifyGrokAuthFailure,
  formatGrokAuthFailure,
  parseGrokCliModelId,
  resolveGrokCliUpstreamModel,
  extractGrokCliImageGenerationResults,
  normalizeGrokCliImageRef,
  collectGrokCliImageRefs,
  normalizeGrokCliUsage,
  stripGrokCliDataUrlPrefix,
  parseGrokCliRateLimitHeaders,
  parseGrokCliExhaustedBody,
  normalizeGrokCliMessagesForOpenAI,
  grokCliContentBlocksToText,
  GROK_CLI_TOKEN_LIMIT,
  GROK_CLI_CATALOG_IDS,
  GROK_CLI_CREDIT_SOFT_ERROR,
} from "./index";

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

  test("accepts farm fixture nested shape (etteum_push account_to_import_item)", () => {
    // Mirrors scripts/grok-farm/fixtures/cpa_nested_tokens.json
    const out = normalizeGrokCliCpa({
      email: "farm-nested@example.com",
      password: "secret-pw",
      tokens: {
        access_token: "at-nested",
        refresh_token: "rt-nested",
        id_token: "idt-nested",
        expires_at: "2026-07-17T12:00:00Z",
        client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      },
    });
    expect(out.email).toBe("farm-nested@example.com");
    expect(out.access_token).toBe("at-nested");
    expect(out.refresh_token).toBe("rt-nested");
  });

  test("accepts farm fixture flat shape", () => {
    const out = normalizeGrokCliCpa({
      email: "farm-flat@example.com",
      access_token: "at-flat",
      refresh_token: "rt-flat",
      id_token: "idt-flat",
      expires_at: "2026-07-17T12:00:00Z",
    });
    expect(out.access_token).toBe("at-flat");
    expect(out.refresh_token).toBe("rt-flat");
  });
});


describe("grokOwnsModel / catalog", () => {
  test("owns grok-4.5 and effort model ids only", () => {
    expect(grokCliOwnsModel("grok-4.5")).toBe(true);
    expect(grokCliOwnsModel("grok-4.5-low")).toBe(true);
    expect(grokCliOwnsModel("grok-4.5-medium")).toBe(true);
    expect(grokCliOwnsModel("grok-4.5-high")).toBe(true);
    expect(grokCliOwnsModel("grok-4.5-xhigh")).toBe(true);
    expect(grokCliOwnsModel("grok-image")).toBe(true);
  });
  test("hard cut: no gcli/ prefix ownership", () => {
    expect(grokCliOwnsModel("gcli/grok-4.5")).toBe(false);
    expect(grokCliOwnsModel("gcli/grok-4.5-high")).toBe(false);
  });
  test("does not own claude/gpt/grok-build", () => {
    expect(grokCliOwnsModel("claude-sonnet-4.6")).toBe(false);
    expect(grokCliOwnsModel("gpt-4o")).toBe(false);
    expect(grokCliOwnsModel("grok-build")).toBe(false);
  });
});

describe("parseGrokModelId", () => {
  test("maps effort model ids to upstream grok-4.5 + effort", () => {
    const base = parseGrokCliModelId("grok-4.5");
    expect(base.upstream).toBe("grok-4.5");
    expect(base.effort).toBeNull();
    expect(parseGrokCliModelId("grok-4.5-high").effort).toBe("high");
    expect(parseGrokCliModelId("grok-4.5-medium").effort).toBe("medium");
    expect(parseGrokCliModelId("grok-4.5-low").effort).toBe("low");
    expect(parseGrokCliModelId("grok-4.5-xhigh").effort).toBe("xhigh");
    expect(resolveGrokCliUpstreamModel("grok-4.5-high")).toBe("grok-4.5");
  });
  test("catalog is bare + four effort ids", () => {
    expect(GROK_CLI_CATALOG_IDS).toEqual([
      "grok-4.5",
      "grok-4.5-low",
      "grok-4.5-medium",
      "grok-4.5-high",
      "grok-4.5-xhigh",
    ]);
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
    expect(h["x-grok-client-identifier"]).toBe("grok-shell");
    expect(h["User-Agent"]).toMatch(/^grok-shell\//);
    expect(h["x-grok-req-id"]).toBeTruthy();
    expect(h["x-grok-session-id"]).toBeTruthy();
    expect(h["x-grok-conv-id"]).toBeTruthy();
    expect(h["x-grok-agent-id"]).toBeTruthy();
    expect(h["x-email"]).toBe("a@x.com");
    expect(h["x-teamid"]).toBe("t1");
    expect(h["x-userid"]).toBe("u1");
    expect(h["x-grok-user-id"]).toBe("u1");
  });
  test("model override for grok-4.5", () => {
    const h = buildGrokCliHeaders({ access_token: "tok" }, "grok-4.5");
    expect(h["x-grok-model-override"]).toBe("grok-4.5");
  });
});

describe("classifyGrokCliError", () => {
  test("403 spending limit => exhausted", () => {
    expect(classifyGrokCliError(403, "credits are exhausted")).toBe("exhausted");
  });
  test("402 personal-team-blocked:spending-limit => exhausted", () => {
    // Live center: free/personal team blocked — not 403, hyphenated code.
    const body = JSON.stringify({
      code: "personal-team-blocked:spending-limit",
      error:
        "You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage",
    });
    expect(classifyGrokCliError(402, body)).toBe("exhausted");
  });
  test("402 alone (no body) => exhausted", () => {
    expect(classifyGrokCliError(402, "")).toBe("exhausted");
  });
  test("429 free-usage-exhausted body => exhausted", () => {
    expect(
      classifyGrokCliError(
        429,
        "subscription:free-usage-exhausted tokens (actual/limit): 1053503/1000000"
      )
    ).toBe("exhausted");
  });
  test("run out of credits text => exhausted", () => {
    expect(classifyGrokCliError(400, "You have run out of credits")).toBe("exhausted");
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

describe("parseGrokCliRateLimitHeaders", () => {
  test("reads x-ratelimit token/request counters", () => {
    const h = new Headers({
      "x-ratelimit-limit-tokens": "1000000",
      "x-ratelimit-remaining-tokens": "420000",
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "77",
    });
    expect(parseGrokCliRateLimitHeaders(h)).toEqual({
      limitTokens: 1_000_000,
      remainingTokens: 420_000,
      limitRequests: 100,
      remainingRequests: 77,
    });
  });
  test("tolerates plain object / missing", () => {
    expect(parseGrokCliRateLimitHeaders({})).toEqual({});
    expect(
      parseGrokCliRateLimitHeaders({ "X-Ratelimit-Remaining-Tokens": "12" })
    ).toEqual({ remainingTokens: 12 });
  });
});

describe("parseGrokCliExhaustedBody", () => {
  test("parses tokens (actual/limit) from free-usage body", () => {
    expect(
      parseGrokCliExhaustedBody(
        "subscription:free-usage-exhausted tokens (actual/limit): 1053503/1000000"
      )
    ).toEqual({ actual: 1_053_503, limit: 1_000_000, remaining: 0 });
  });
  test("null when no match", () => {
    expect(parseGrokCliExhaustedBody("boom")).toBeNull();
  });
});

describe("GROK_CLI_CREDIT_SOFT_ERROR", () => {
  test("stable soft string for clients", () => {
    expect(GROK_CLI_CREDIT_SOFT_ERROR).toMatch(/credits exhausted/i);
  });
});

describe("isGrokCliDeadError", () => {
  test("matches invalid_grant / revoked / Grok dead prefix", () => {
    expect(isGrokCliDeadError('invalid_grant: {"error":"invalid_grant"}')).toBe(true);
    expect(isGrokCliDeadError("Refresh token has been revoked")).toBe(true);
    expect(isGrokCliDeadError("Grok dead: invalid_grant")).toBe(true);
    // Missing credentials are unusable for traffic (dead) but not permanent IdP death.
    expect(isGrokCliDeadError("No access_token for grok-cli account")).toBe(true);
  });
  test("does not match generic auth/network", () => {
    expect(isGrokCliDeadError("Grok auth: unauthorized")).toBe(false);
    expect(isGrokCliDeadError("timeout")).toBe(false);
    expect(isGrokCliDeadError(null)).toBe(false);
  });
  test("missing credentials stay non-permanent (WarmUp must not latch)", async () => {
    const { isPermanentRevocation, isMissingCredentialMessage } = await import(
      "../../account-health"
    );
    const msg = "No access_token for grok-cli account";
    expect(isGrokCliDeadError(msg)).toBe(true);
    expect(isMissingCredentialMessage(msg)).toBe(true);
    expect(isPermanentRevocation(msg)).toBe(false);
    // The permanent latch string itself must only match real IdP death.
    expect(isPermanentRevocation("Grok dead: invalid_grant")).toBe(true);
    expect(isPermanentRevocation(msg)).toBe(false);
  });
});

describe("formatGrokAuthFailure", () => {
  test("permanent IdP death gets latch prefix + deadAccount", () => {
    const out = formatGrokAuthFailure('invalid_grant: {"error":"invalid_grant"}');
    expect(out.kind).toBe("permanent");
    expect(out.permanent).toBe(true);
    expect(out.deadAccount).toBe(true);
    expect(out.error.toLowerCase()).toContain("grok cli dead");
    expect(classifyGrokAuthFailure(out.error)).toBe("permanent");
  });

  test("missing credentials stay plain (no latch prefix)", () => {
    const out = formatGrokAuthFailure("No access_token for grok-cli account");
    expect(out.kind).toBe("missing");
    expect(out.permanent).toBe(false);
    expect(out.deadAccount).toBe(true);
    expect(out.error).toBe("No access_token for grok-cli account");
    expect(out.error.toLowerCase()).not.toContain("grok cli dead");
  });

  test("generic auth is non-dead with auth prefix", () => {
    const out = formatGrokAuthFailure("unauthorized");
    expect(out.kind).toBe("auth");
    expect(out.deadAccount).toBe(false);
    expect(out.error).toBe("Grok auth: unauthorized");
  });
});

describe("constants", () => {
  test("token limit is 2M", () => {
    expect(GROK_CLI_TOKEN_LIMIT).toBe(2_000_000);
  });
});

describe("quota probe model (regression)", () => {
  // WarmUp mass-exhausted 627 accounts because the probe body sent
  // model "grok-4" — a non-entitled model the center rejects with 402 for
  // every free/personal team. Catalog upstream is "grok-4.5" only.
  test("catalog upstream model is grok-4.5", () => {
    expect(resolveGrokCliUpstreamModel("grok-4.5")).toBe("grok-4.5");
    expect(resolveGrokCliUpstreamModel("grok-4.5")).toBe("grok-4.5");
    expect(resolveGrokCliUpstreamModel("grok-4.5-high")).toBe("grok-4.5");
    expect(resolveGrokCliUpstreamModel("grok-4.5-low")).toBe("grok-4.5");
  });
  test("grok-4 (no .5) is NOT the catalog upstream", () => {
    // The buggy probe sent this exact string. Resolve must keep it as the
    // catalog upstream; rejecting "grok-4" is the provider's job upstream,
    // but the probe body must use what resolve returns for a catalog id.
    expect(resolveGrokCliUpstreamModel("grok-4.5")).not.toBe("grok-4");
  });
});

describe("normalizeGrokCliMessagesForOpenAI", () => {
  // Live Claude Code body that triggered:
  //   400 invalid-argument Empty content block
  // because content was Anthropic block array, not a plain string.
  test("flattens Claude Code text block arrays to strings", () => {
    const out = normalizeGrokCliMessagesForOpenAI([
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>\nToday\n</system-reminder>\n\n" },
          { type: "text", text: "test" },
        ],
      },
      {
        role: "system",
        content: "Available agent types…",
      },
    ] as any);
    expect(out).toEqual([
      {
        role: "user",
        content: "<system-reminder>\nToday\n</system-reminder>\n\n\ntest",
      },
      { role: "system", content: "Available agent types…" },
    ]);
  });

  test("passthrough plain string content", () => {
    const out = normalizeGrokCliMessagesForOpenAI([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ] as any);
    expect(out).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  test("lifts Anthropic tool_use + tool_result into OpenAI shape", () => {
    const out = normalizeGrokCliMessagesForOpenAI([
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling tool" },
          { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "file.txt" },
          { type: "text", text: "continue" },
        ],
      },
    ] as any);
    expect(out[0]).toEqual({
      role: "assistant",
      content: "calling tool",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify({ command: "ls" }) },
        },
      ],
    });
    expect(out[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: "file.txt" });
    expect(out[2]).toEqual({ role: "user", content: "continue" });
  });

  test("grokCliContentBlocksToText joins text parts", () => {
    expect(
      grokCliContentBlocksToText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ])
    ).toBe("a\nb");
    expect(grokCliContentBlocksToText("plain")).toBe("plain");
    expect(grokCliContentBlocksToText(null)).toBe("");
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

  test("owns grok-image", () => {
    expect(grokCliOwnsModel("grok-image")).toBe(true);
  });
});
