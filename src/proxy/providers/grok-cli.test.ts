import { describe, expect, test } from "bun:test";
import {
  normalizeGrokCliCpa,
  grokCliOwnsModel,
  buildGrokCliHeaders,
  classifyGrokCliError,
  GROK_CLI_TOKEN_LIMIT,
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
  test("owns grok-4.5", () => {
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
    expect(h["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
    expect(h["x-xai-token-auth"]).toBe("xai-grok-cli");
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

describe("constants", () => {
  test("token limit is 2M", () => {
    expect(GROK_CLI_TOKEN_LIMIT).toBe(2_000_000);
  });
});
