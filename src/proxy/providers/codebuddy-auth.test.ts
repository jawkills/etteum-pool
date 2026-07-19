import { describe, expect, test } from "bun:test";
import {
  CODEBUDDY_CREDIT_SOFT_ERROR,
  classifyCodeBuddyHttpFailure,
  isCodeBuddyCreditDeath,
  normalizeCodeBuddySessionImport,
  parseCodeBuddyResourceQuota,
  parseCodeBuddyTokens,
  resolveCodeBuddyUserId,
} from "./codebuddy-auth";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("resolveCodeBuddyUserId", () => {
  test("returns JWT sub when present and long enough", () => {
    const jwt = makeJwt({ sub: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", email: "a@b.com" });
    expect(resolveCodeBuddyUserId(jwt)).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(resolveCodeBuddyUserId(`Bearer ${jwt}`)).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  test("omits opaque ck_ API keys and short sub", () => {
    expect(resolveCodeBuddyUserId("ck_fpigz68zr75sdeadbeef")).toBeUndefined();
    expect(resolveCodeBuddyUserId(makeJwt({ sub: "short" }))).toBeUndefined();
    expect(resolveCodeBuddyUserId("")).toBeUndefined();
    expect(resolveCodeBuddyUserId(undefined)).toBeUndefined();
  });
});

describe("isCodeBuddyCreditDeath", () => {
  test("429 and 402 are credit death", () => {
    expect(isCodeBuddyCreditDeath(429, "")).toBe(true);
    expect(isCodeBuddyCreditDeath(402, "")).toBe(true);
  });

  test("body Credits exhausted / 11216", () => {
    expect(
      isCodeBuddyCreditDeath(
        200,
        "Credits exhausted. Please visit https://www.codebuddy.ai/profile/usage",
      ),
    ).toBe(true);
    expect(isCodeBuddyCreditDeath(400, JSON.stringify({ code: 11216, msg: "TrialExpired" }))).toBe(
      true,
    );
    expect(isCodeBuddyCreditDeath(400, JSON.stringify({ code: 11212 }))).toBe(true);
  });

  test("plain 401 without credit body is not credit death", () => {
    expect(isCodeBuddyCreditDeath(401, "unauthorized")).toBe(false);
    expect(isCodeBuddyCreditDeath(403, "forbidden")).toBe(false);
  });

  test("model errors are not credit death", () => {
    expect(isCodeBuddyCreditDeath(400, "model_not_found: cb-foo")).toBe(false);
    expect(isCodeBuddyCreditDeath(404, JSON.stringify({ error: "invalid model" }))).toBe(false);
  });
});

describe("classifyCodeBuddyHttpFailure", () => {
  test("soft error for credit death", () => {
    const r = classifyCodeBuddyHttpFailure(429, "Credits exhausted...");
    expect(r.quotaExhausted).toBe(true);
    expect(r.error).toBe(CODEBUDDY_CREDIT_SOFT_ERROR);
  });

  test("session expired for plain 401", () => {
    const r = classifyCodeBuddyHttpFailure(401, "nope");
    expect(r.sessionExpired).toBe(true);
    expect(r.quotaExhausted).toBeUndefined();
  });
});

describe("parseCodeBuddyTokens", () => {
  test("unwraps double-encoded JSON string", () => {
    const once = JSON.stringify({ api_key: "ck_abc" });
    const twice = JSON.stringify(once);
    expect(parseCodeBuddyTokens(twice)?.api_key).toBe("ck_abc");
    expect(parseCodeBuddyTokens(once)?.api_key).toBe("ck_abc");
    expect(parseCodeBuddyTokens({ api_key: "ck_abc" })?.api_key).toBe("ck_abc");
  });
});

describe("normalizeCodeBuddySessionImport", () => {
  test("accepts JWT string and CLI auth.info", () => {
    const jwt = makeJwt({ sub: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" });
    const fromJwt = normalizeCodeBuddySessionImport(jwt);
    expect("tokens" in fromJwt && fromJwt.tokens.access_token).toBe(jwt);

    const fromAuth = normalizeCodeBuddySessionImport({
      auth: { accessToken: jwt, refreshToken: "r" },
      account: { email: "u@x.com", uid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
    });
    expect("tokens" in fromAuth && fromAuth.tokens.access_token).toBe(jwt);
    expect("email" in fromAuth && fromAuth.email).toBe("u@x.com");
  });

  test("accepts ck_ api key", () => {
    const r = normalizeCodeBuddySessionImport("ck_fpigz68zr75s");
    expect("tokens" in r && r.tokens.api_key).toBe("ck_fpigz68zr75s");
  });
});

describe("parseCodeBuddyResourceQuota", () => {
  test("sums CapacityRemain", () => {
    const q = parseCodeBuddyResourceQuota({
      data: {
        Response: {
          Data: {
            TotalDosage: 0,
            Accounts: [
              { CapacityRemain: 10, CapacityUsed: 1, CapacitySize: 20 },
              { CapacityRemain: 5, CapacityUsed: 2, CapacitySize: 10 },
            ],
          },
        },
      },
    });
    expect(q.ambiguous).toBeUndefined();
    expect(q.remaining).toBe(15);
    expect(q.limit).toBe(30);
  });

  test("TotalDosage 0 + empty Accounts is ambiguous", () => {
    const q = parseCodeBuddyResourceQuota({
      data: { Response: { Data: { TotalDosage: 0, Accounts: [] } } },
    });
    expect(q.ambiguous).toBe(true);
  });
});
