import { describe, expect, test } from "bun:test";
import { parseGrokFarmLogLine, createIdleGrokFarmStatus } from "./grok-farm-queue";

describe("createIdleGrokFarmStatus", () => {
  test("idle shape", () => {
    const s = createIdleGrokFarmStatus();
    expect(s.running).toBe(false);
    expect(s.target).toBe(0);
    expect(s.success).toBe(0);
    expect(s.failed).toBe(0);
  });
});

describe("parseGrokFarmLogLine", () => {
  test("detects OK summary", () => {
    const p = parseGrokFarmLogLine(" OK 3  FAIL 1  TOTAL 5  OUT C:\\x\\batch_1");
    expect(p?.kind).toBe("summary");
    if (p?.kind === "summary") {
      expect(p.success).toBe(3);
      expect(p.failed).toBe(1);
    }
  });

  test("detects batch dir", () => {
    const p = parseGrokFarmLogLine("[BATCH] dir=C:\\farm\\results\\batch_abc");
    expect(p?.kind).toBe("batch_dir");
    if (p?.kind === "batch_dir") {
      expect(p.batchDir).toContain("batch_abc");
    }
  });

  test("detects STEP with email and label", () => {
    const p = parseGrokFarmLogLine("12:34:56  [STEP]  #2  user@x.com  OTP");
    expect(p?.kind).toBe("step");
    if (p?.kind === "step") {
      expect(p.attempt).toBe(2);
      expect(p.email).toBe("user@x.com");
      expect(p.step).toBe("OTP");
    }
  });

  test("detects OK account", () => {
    const p = parseGrokFarmLogLine("12:34:56  [OK]  #1  a@x.com  12s");
    expect(p?.kind).toBe("ok");
    if (p?.kind === "ok") {
      expect(p.attempt).toBe(1);
      expect(p.email).toBe("a@x.com");
    }
  });

  test("detects FAIL", () => {
    const p = parseGrokFarmLogLine("12:34:56  [FAIL]  #3  b@x.com  CAPTCHA:FAIL");
    expect(p?.kind).toBe("fail");
    if (p?.kind === "fail") {
      expect(p.attempt).toBe(3);
      expect(p.detail).toContain("CAPTCHA");
    }
  });
});
