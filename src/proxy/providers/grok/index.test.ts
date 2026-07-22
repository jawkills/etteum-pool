import { describe, expect, test } from "bun:test";
import {
  normalizeGrokCpa,
  grokCliOwnsModel,
  buildGrokHeaders,
  classifyGrokError,
  isGrokDeadError,
  classifyGrokAuthFailure,
  formatGrokAuthFailure,
  parseGrokCliModelId,
  resolveGrokCliUpstreamModel,
  extractGrokImageGenerationResults,
  normalizeGrokImageRef,
  collectGrokImageRefs,
  normalizeGrokUsage,
  stripGrokDataUrlPrefix,
  parseGrokRateLimitHeaders,
  parseGrokExhaustedBody,
  normalizeGrokMessagesForOpenAI,
  grokContentBlocksToText,
  parseRetryAfterMs,
  GROK_TOKEN_LIMIT,
  GROK_CLI_CATALOG_IDS,
  GROK_CREDIT_SOFT_ERROR,
} from "./index";

describe("normalizeGrokCpa", () => {
  test("accepts flat CPA", () => {
    const out = normalizeGrokCpa({
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
    const out = normalizeGrokCpa({
      email: "b@x.com",
      tokens: { access_token: "at2", refresh_token: "rt2", id_token: "id2" },
    });
    expect(out.access_token).toBe("at2");
    expect(out.refresh_token).toBe("rt2");
  });

  test("accepts camelCase keys", () => {
    const out = normalizeGrokCpa({
      email: "c@x.com",
      accessToken: "at3",
      refreshToken: "rt3",
    });
    expect(out.access_token).toBe("at3");
    expect(out.refresh_token).toBe("rt3");
  });

  test("throws when tokens missing", () => {
    expect(() => normalizeGrokCpa({ email: "x@x.com" })).toThrow(/access_token/);
  });

  test("extracts team_id/sub from id_token JWT payload when present", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "user-1", team_id: "team-9" })).toString("base64url");
    const idToken = `aaa.${payload}.bbb`;
    const out = normalizeGrokCpa({
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
    const out = normalizeGrokCpa({
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
    const out = normalizeGrokCpa({
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

describe("buildGrokHeaders", () => {
  test("includes required CLI auth headers and model override", () => {
    const h = buildGrokHeaders(
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
    const h = buildGrokHeaders({ access_token: "tok" }, "grok-4.5");
    expect(h["x-grok-model-override"]).toBe("grok-4.5");
  });
});

describe("classifyGrokError", () => {
  test("403 spending limit => exhausted", () => {
    expect(classifyGrokError(403, "credits are exhausted")).toBe("exhausted");
  });
  test("402 personal-team-blocked:spending-limit => exhausted", () => {
    // Live center: free/personal team blocked — not 403, hyphenated code.
    const body = JSON.stringify({
      code: "personal-team-blocked:spending-limit",
      error:
        "You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage",
    });
    expect(classifyGrokError(402, body)).toBe("exhausted");
  });
  test("402 alone (no body) => exhausted", () => {
    expect(classifyGrokError(402, "")).toBe("exhausted");
  });
  test("429 free-usage-exhausted body => exhausted", () => {
    expect(
      classifyGrokError(
        429,
        "subscription:free-usage-exhausted tokens (actual/limit): 1053503/1000000"
      )
    ).toBe("exhausted");
  });
  test("run out of credits text => exhausted", () => {
    expect(classifyGrokError(400, "You have run out of credits")).toBe("exhausted");
  });
  test("401 revoked => dead", () => {
    expect(classifyGrokError(401, "invalid_grant revoked")).toBe("dead");
  });
  test("401 generic => auth", () => {
    expect(classifyGrokError(401, "unauthorized")).toBe("auth");
  });
  test("500 still => null (unchanged)", () => {
    expect(classifyGrokError(500, "boom")).toBe(null);
  });

  // --- capacity / rate_limited (transient upstream overload) ---
  test("529 capacity message => rate_limited", () => {
    expect(
      classifyGrokError(
        529,
        "The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing: https://docs.x.ai/developers/advanced-api-usage/priority-processing"
      )
    ).toBe("rate_limited");
  });
  test("503 service unavailable => rate_limited", () => {
    expect(classifyGrokError(503, "Service Unavailable")).toBe("rate_limited");
  });
  test("503 with capacity body => rate_limited", () => {
    expect(classifyGrokError(503, "at capacity due to high demand")).toBe("rate_limited");
  });
  test("429 capacity body (no quota markers) => rate_limited, NOT exhausted", () => {
    expect(
      classifyGrokError(429, "at capacity due to high demand")
    ).toBe("rate_limited");
  });
  test("429 rate limit exceeded text => rate_limited", () => {
    expect(classifyGrokError(429, "rate limit exceeded")).toBe("rate_limited");
  });
  test("429 too many requests text => rate_limited", () => {
    expect(classifyGrokError(429, "too many requests")).toBe("rate_limited");
  });
  test("overloaded text at any status => rate_limited", () => {
    expect(classifyGrokError(200, "The model is overloaded")).toBe("rate_limited");
  });
  test("temporarily unavailable text => rate_limited", () => {
    expect(classifyGrokError(503, "temporarily unavailable")).toBe("rate_limited");
  });
  test("priority processing text => rate_limited", () => {
    expect(
      classifyGrokError(429, "use a higher service tier for priority processing")
    ).toBe("rate_limited");
  });

  // --- REGRESSION: 429 with quota body MUST stay exhausted (not rate_limited) ---
  test("429 with quota tokens body => exhausted (REGRESSION)", () => {
    expect(
      classifyGrokError(
        429,
        "subscription:free-usage-exhausted tokens (actual/limit): 1053503/1000000"
      )
    ).toBe("exhausted");
  });
  test("429 with free-usage body => exhausted (REGRESSION)", () => {
    expect(classifyGrokError(429, "free-usage-exhausted")).toBe("exhausted");
  });
  test("429 with quota+exceed body => exhausted (REGRESSION)", () => {
    expect(classifyGrokError(429, "quota has been exceeded")).toBe("exhausted");
  });
});

describe("parseRetryAfterMs", () => {
  test("numeric seconds value (5s -> 5000ms)", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "5" }))).toBe(5000);
  });
  test("numeric seconds value (0 -> clamped to 1000ms minimum)", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "0" }))).toBe(1000);
  });
  test("numeric seconds clamped to max 10000ms", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "120" }))).toBe(10000);
  });
  test("HTTP-date in the future returns a positive ms duration", () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const result = parseRetryAfterMs(new Headers({ "retry-after": future }));
    expect(typeof result).toBe("number");
    expect(result!).toBeGreaterThan(0);
    expect(result!).toBeLessThanOrEqual(10_000);
  });
  test("HTTP-date in the past returns 1000ms (minimum)", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterMs(new Headers({ "retry-after": past }))).toBe(1000);
  });
  test("missing header => undefined", () => {
    expect(parseRetryAfterMs(new Headers({}))).toBeUndefined();
  });
  test("empty header => undefined", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "" }))).toBeUndefined();
  });
  test("garbage non-numeric, non-date => undefined", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "not-a-date-or-number" }))).toBeUndefined();
  });
  test("plain object headers supported", () => {
    expect(parseRetryAfterMs({ "retry-after": "3" } as any)).toBe(3000);
  });
  test("capitalized header name supported (case-insensitive)", () => {
    expect(parseRetryAfterMs({ "Retry-After": "3" } as any)).toBe(3000);
  });
});

describe("parseGrokRateLimitHeaders", () => {
  test("reads x-ratelimit token/request counters", () => {
    const h = new Headers({
      "x-ratelimit-limit-tokens": "1000000",
      "x-ratelimit-remaining-tokens": "420000",
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "77",
    });
    expect(parseGrokRateLimitHeaders(h)).toEqual({
      limitTokens: 1_000_000,
      remainingTokens: 420_000,
      limitRequests: 100,
      remainingRequests: 77,
    });
  });
  test("tolerates plain object / missing", () => {
    expect(parseGrokRateLimitHeaders({})).toEqual({});
    expect(
      parseGrokRateLimitHeaders({ "X-Ratelimit-Remaining-Tokens": "12" })
    ).toEqual({ remainingTokens: 12 });
  });
});

describe("parseGrokExhaustedBody", () => {
  test("parses tokens (actual/limit) from free-usage body", () => {
    expect(
      parseGrokExhaustedBody(
        "subscription:free-usage-exhausted tokens (actual/limit): 1053503/1000000"
      )
    ).toEqual({ actual: 1_053_503, limit: 1_000_000, remaining: 0 });
  });
  test("null when no match", () => {
    expect(parseGrokExhaustedBody("boom")).toBeNull();
  });
});

describe("GROK_CREDIT_SOFT_ERROR", () => {
  test("stable soft string for clients", () => {
    expect(GROK_CREDIT_SOFT_ERROR).toMatch(/credits exhausted/i);
  });
});

describe("isGrokDeadError", () => {
  test("matches invalid_grant / revoked / Grok dead prefix", () => {
    expect(isGrokDeadError('invalid_grant: {"error":"invalid_grant"}')).toBe(true);
    expect(isGrokDeadError("Refresh token has been revoked")).toBe(true);
    expect(isGrokDeadError("Grok dead: invalid_grant")).toBe(true);
    // Missing credentials are unusable for traffic (dead) but not permanent IdP death.
    expect(isGrokDeadError("No access_token for grok-cli account")).toBe(true);
  });
  test("does not match generic auth/network", () => {
    expect(isGrokDeadError("Grok auth: unauthorized")).toBe(false);
    expect(isGrokDeadError("timeout")).toBe(false);
    expect(isGrokDeadError(null)).toBe(false);
  });
  test("missing credentials stay non-permanent (WarmUp must not latch)", async () => {
    const { isPermanentRevocation, isMissingCredentialMessage } = await import(
      "../../account-health"
    );
    const msg = "No access_token for grok-cli account";
    expect(isGrokDeadError(msg)).toBe(true);
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
    expect(out.error.toLowerCase()).toContain("grok dead");
    expect(classifyGrokAuthFailure(out.error)).toBe("permanent");
  });

  test("missing credentials stay plain (no latch prefix)", () => {
    const out = formatGrokAuthFailure("No access_token for grok-cli account");
    expect(out.kind).toBe("missing");
    expect(out.permanent).toBe(false);
    expect(out.deadAccount).toBe(true);
    expect(out.error).toBe("No access_token for grok-cli account");
    expect(out.error.toLowerCase()).not.toContain("grok dead");
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
    expect(GROK_TOKEN_LIMIT).toBe(2_000_000);
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

describe("normalizeGrokMessagesForOpenAI", () => {
  // Live Claude Code body that triggered:
  //   400 invalid-argument Empty content block
  // because content was Anthropic block array, not a plain string.
  test("flattens Claude Code text block arrays to strings", () => {
    const out = normalizeGrokMessagesForOpenAI([
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
    const out = normalizeGrokMessagesForOpenAI([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ] as any);
    expect(out).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  test("lifts Anthropic tool_use + tool_result into OpenAI shape", () => {
    const out = normalizeGrokMessagesForOpenAI([
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

  test("grokContentBlocksToText joins text parts", () => {
    expect(
      grokContentBlocksToText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ])
    ).toBe("a\nb");
    expect(grokContentBlocksToText("plain")).toBe("plain");
    expect(grokContentBlocksToText(null)).toBe("");
  });
});

describe("image helpers", () => {
  test("stripGrokDataUrlPrefix removes data URL wrapper", () => {
    expect(stripGrokDataUrlPrefix("data:image/png;base64,abc123")).toBe("abc123");
    expect(stripGrokDataUrlPrefix("abc123")).toBe("abc123");
  });

  test("normalizeGrokImageRef handles bare b64, data URL, https", () => {
    expect(normalizeGrokImageRef("aGVsbG8=")).toBe("data:image/png;base64,aGVsbG8=");
    expect(normalizeGrokImageRef("data:image/jpeg;base64,/9j/xx")).toBe("data:image/jpeg;base64,/9j/xx");
    expect(normalizeGrokImageRef("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(normalizeGrokImageRef({ b64_json: "zzz" })).toBe("data:image/png;base64,zzz");
    expect(normalizeGrokImageRef(null)).toBe(null);
  });

  test("collectGrokImageRefs gathers image/images and caps", () => {
    const refs = collectGrokImageRefs(
      {
        image: "aaa",
        images: ["bbb", "ccc", "ddd", "eee"],
      },
      3
    );
    // images array is collected first, then image — cap 3
    expect(refs).toHaveLength(3);
  });

  test("extractGrokImageGenerationResults reads image_generation_call", () => {
    const payload = {
      output: [
        { type: "reasoning", content: [] },
        { type: "image_generation_call", result: "data:image/jpeg;base64,/9j/4AAQ" },
        { type: "image_generation_call", result: { b64_json: "qqq" } },
      ],
    };
    expect(extractGrokImageGenerationResults(payload)).toEqual(["/9j/4AAQ", "qqq"]);
  });

  test("normalizeGrokUsage maps input/output aliases", () => {
    expect(normalizeGrokUsage({ input_tokens: 10, output_tokens: 20 })).toEqual({
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
