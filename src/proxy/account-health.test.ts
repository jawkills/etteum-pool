import { describe, expect, test } from "bun:test";
import {
  classifyOfflineAccount,
  inspectTokens,
  isDeadErrorMessage,
  isPlaceholderPassword,
  parseExpiresAtSec,
} from "./account-health";

describe("parseExpiresAtSec", () => {
  test("unix seconds", () => {
    expect(parseExpiresAtSec(1_700_000_000)).toBe(1_700_000_000);
  });
  test("unix milliseconds", () => {
    expect(parseExpiresAtSec(1_700_000_000_000)).toBe(1_700_000_000);
  });
  test("ISO string", () => {
    const sec = parseExpiresAtSec("2024-01-01T00:00:00.000Z");
    expect(sec).toBe(Math.floor(Date.parse("2024-01-01T00:00:00.000Z") / 1000));
  });
  test("numeric string seconds", () => {
    expect(parseExpiresAtSec("1700000000")).toBe(1_700_000_000);
  });
  test("null/empty", () => {
    expect(parseExpiresAtSec(null)).toBe(null);
    expect(parseExpiresAtSec("")).toBe(null);
    expect(parseExpiresAtSec(undefined)).toBe(null);
  });
});

describe("isPermanentRevocation / isDeadErrorMessage", () => {
  test("permanent revocation is IdP death only", async () => {
    const { isPermanentRevocation, isMissingCredentialMessage } = await import("./account-health");
    expect(isPermanentRevocation('invalid_grant: {"error":"invalid_grant"}')).toBe(true);
    expect(isPermanentRevocation("Refresh token has been revoked")).toBe(true);
    expect(isPermanentRevocation("Grok dead: invalid_grant")).toBe(true);
    expect(isPermanentRevocation("Account dead")).toBe(true);
    expect(isPermanentRevocation("no access_token")).toBe(false);
    expect(isMissingCredentialMessage("no access_token")).toBe(true);
    expect(isMissingCredentialMessage("No access_token for grok account")).toBe(true);
    expect(isMissingCredentialMessage("invalid_grant")).toBe(false);
  });
  test("isDeadErrorMessage unions permanent + missing", () => {
    expect(isDeadErrorMessage('invalid_grant: {"error":"invalid_grant"}')).toBe(true);
    expect(isDeadErrorMessage("no access_token")).toBe(true);
    expect(isDeadErrorMessage("Grok auth: unauthorized")).toBe(false);
    expect(isDeadErrorMessage("timeout")).toBe(false);
    expect(isDeadErrorMessage("session_expired")).toBe(false);
    expect(isDeadErrorMessage(null)).toBe(false);
  });
});

describe("isPlaceholderPassword", () => {
  test("synthetic signup markers are placeholders", () => {
    expect(isPlaceholderPassword("grok-cli-token-auth")).toBe(true);
    expect(isPlaceholderPassword("grok-token-auth")).toBe(true);
    expect(isPlaceholderPassword("instant-login")).toBe(true);
    expect(isPlaceholderPassword("pat-login")).toBe(true);
  });
  test("empty / null / undefined are placeholders", () => {
    expect(isPlaceholderPassword("")).toBe(true);
    expect(isPlaceholderPassword(null)).toBe(true);
    expect(isPlaceholderPassword(undefined)).toBe(true);
  });
  test("operator-provided password is not a placeholder", () => {
    expect(isPlaceholderPassword("mySecret123")).toBe(false);
    expect(isPlaceholderPassword("a")).toBe(false);
  });
});

describe("inspectTokens", () => {
  const now = 1_700_000_000;
  const lead = 45 * 60;

  test("fresh access", () => {
    const t = inspectTokens(
      { access_token: "a", refresh_token: "r", expires_at: now + 3600 },
      now,
      lead
    );
    expect(t.freshness).toBe("fresh");
    expect(t.hasAccess).toBe(true);
    expect(t.hasRefresh).toBe(true);
  });

  test("expired access still has refresh", () => {
    const t = inspectTokens(
      { access_token: "a", refresh_token: "r", expires_at: now - 10 },
      now,
      lead
    );
    expect(t.freshness).toBe("expired");
    expect(t.hasRefresh).toBe(true);
  });

  test("no_token empty", () => {
    expect(inspectTokens(null, now, lead).freshness).toBe("no_token");
    expect(inspectTokens("{}", now, lead).freshness).toBe("no_token");
  });

  test("opaque session blob", () => {
    const t = inspectTokens({ session: "abc", cookie: "x" }, now, lead);
    expect(t.opaqueSession).toBe(true);
    expect(t.freshness).toBe("unknown");
  });

  test("nested harvest shape", () => {
    const t = inspectTokens(
      { tokens: { access_token: "a", refresh_token: "r", expires_at: now + 9999 } },
      now,
      lead
    );
    expect(t.hasAccess).toBe(true);
    expect(t.freshness).toBe("fresh");
  });
});

describe("classifyOfflineAccount", () => {
  const now = 1_700_000_000;
  const lead = 45 * 60;

  test("fresh active is usable", () => {
    const c = classifyOfflineAccount(
      {
        status: "active",
        enabled: 1,
        tokens: { access_token: "a", refresh_token: "r", expires_at: now + 3600 },
      },
      now,
      lead
    );
    expect(c.usable).toBe(true);
    expect(c.zombieActive).toBe(false);
    expect(c.refreshable).toBe(false);
  });

  test("expired with refresh is usable + refreshable (not zombie)", () => {
    const c = classifyOfflineAccount(
      {
        status: "active",
        enabled: true,
        tokens: { access_token: "a", refresh_token: "r", expires_at: now - 60 },
      },
      now,
      lead
    );
    expect(c.usable).toBe(true);
    expect(c.refreshable).toBe(true);
    expect(c.zombieActive).toBe(false);
  });

  test("expired without refresh is zombie", () => {
    const c = classifyOfflineAccount(
      {
        status: "active",
        enabled: 1,
        tokens: { access_token: "a", expires_at: now - 60 },
      },
      now,
      lead
    );
    expect(c.usable).toBe(false);
    expect(c.zombieActive).toBe(true);
  });

  test("active + revoked-looking message is zombie", () => {
    const c = classifyOfflineAccount(
      {
        status: "active",
        enabled: 1,
        errorMessage: "invalid_grant",
        tokens: { access_token: "a", refresh_token: "r", expires_at: now + 3600 },
      },
      now,
      lead
    );
    expect(c.usable).toBe(false);
    expect(c.zombieActive).toBe(true);
    expect(c.revokedLooking).toBe(true);
  });

  test("status=error is errorStatus, not usable", () => {
    const c = classifyOfflineAccount(
      {
        status: "error",
        enabled: 1,
        errorMessage: "timeout",
        tokens: { access_token: "a", refresh_token: "r", expires_at: now + 3600 },
      },
      now,
      lead
    );
    expect(c.errorStatus).toBe(true);
    expect(c.usable).toBe(false);
    expect(c.dbActive).toBe(false);
  });

  test("disabled never usable", () => {
    const c = classifyOfflineAccount(
      {
        status: "active",
        enabled: 0,
        tokens: { access_token: "a", refresh_token: "r", expires_at: now + 3600 },
      },
      now,
      lead
    );
    expect(c.usable).toBe(false);
    expect(c.dbActive).toBe(false);
  });

  test("opaque session active is usable", () => {
    const c = classifyOfflineAccount(
      {
        status: "active",
        enabled: 1,
        tokens: { session_id: "xyz" },
      },
      now,
      lead
    );
    expect(c.usable).toBe(true);
  });
});
