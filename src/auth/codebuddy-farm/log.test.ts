import { describe, expect, test } from "bun:test";
import { parseCodeBuddyFarmLogLine } from "./log";

describe("parseCodeBuddyFarmLogLine", () => {
  test("parses OK line", () => {
    const p = parseCodeBuddyFarmLogLine("12:00:00  [OK]  #1  a@b.com  imported");
    expect(p?.kind).toBe("ok");
    if (p?.kind === "ok") {
      expect(p.attempt).toBe(1);
      expect(p.email).toBe("a@b.com");
      expect(p.detail).toBe("imported");
    }
  });

  test("parses FAIL line", () => {
    const p = parseCodeBuddyFarmLogLine("12:00:00  [FAIL]  #2  -  OAUTH:authorize_to_dashboard");
    expect(p?.kind).toBe("fail");
    if (p?.kind === "fail") {
      expect(p.attempt).toBe(2);
      expect(p.detail).toContain("OAUTH");
    }
  });

  test("parses summary", () => {
    const p = parseCodeBuddyFarmLogLine(" OK 1  FAIL 2  PUSH_FAIL 1  TOTAL 3  OUT /tmp/x");
    expect(p?.kind).toBe("summary");
    if (p?.kind === "summary") {
      expect(p.success).toBe(1);
      expect(p.failed).toBe(2);
      expect(p.pushFailures).toBe(1);
    }
  });

  test("parses NDJSON event", () => {
    const p = parseCodeBuddyFarmLogLine(
      `CODEBUDDY_EVENT ${JSON.stringify({ t: "step", attempt: 3, step: "MINT", email: "x@y.z" })}`,
    );
    expect(p?.kind).toBe("step");
    if (p?.kind === "step") {
      expect(p.attempt).toBe(3);
      expect(p.step).toBe("MINT");
    }
  });
});
