import { describe, expect, test } from "bun:test";
import { parseGrokFarmLogLine } from "./log";
import { createIdleGrokFarmStatus } from "./farm-queue";
import { GrokProcessLatch } from "./process";

describe("createIdleGrokFarmStatus", () => {
  test("idle shape", () => {
    const s = createIdleGrokFarmStatus();
    expect(s.running).toBe(false);
    expect(s.target).toBe(0);
    expect(s.success).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.pushFailures).toBe(0);
  });
});

describe("GrokProcessLatch", () => {
  test("rejects double acquire", () => {
    const latch = new GrokProcessLatch();
    const g1 = latch.tryAcquire();
    expect(g1).toBe(1);
    expect(latch.tryAcquire()).toBeNull();
    expect(latch.release(g1!)).toBe(true);
    const g2 = latch.tryAcquire();
    expect(g2).toBe(2);
  });

  test("stale generation release is ignored after forceClear", () => {
    const latch = new GrokProcessLatch();
    const g1 = latch.tryAcquire();
    expect(g1).toBe(1);
    latch.forceClear(); // bumps generation (simulates user stop)
    expect(latch.release(g1!)).toBe(false);
    expect(latch.isBusy).toBe(false);
    const g2 = latch.tryAcquire();
    expect(g2).toBe(3); // acquire after forceClear bump
    expect(latch.release(g2!)).toBe(true);
  });
});

describe("parseGrokFarmLogLine", () => {
  test("detects OK summary", () => {
    const p = parseGrokFarmLogLine(" OK 3  FAIL 1  TOTAL 5  OUT C:\\x\\batch_1");
    expect(p?.kind).toBe("summary");
    if (p?.kind === "summary") {
      expect(p.success).toBe(3);
      expect(p.failed).toBe(1);
      expect(p.pushFailures).toBeUndefined();
    }
  });

  test("detects summary with PUSH_FAIL column", () => {
    const p = parseGrokFarmLogLine(
      " OK 2  FAIL 3  PUSH_FAIL 2  TOTAL 5  OUT C:\\farm\\results\\batch_abc"
    );
    expect(p?.kind).toBe("summary");
    if (p?.kind === "summary") {
      expect(p.success).toBe(2);
      expect(p.failed).toBe(3);
      expect(p.pushFailures).toBe(2);
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

  test("detects OK account (imported detail after push)", () => {
    const p = parseGrokFarmLogLine("12:34:56  [OK]  #1  a@x.com  imported");
    expect(p?.kind).toBe("ok");
    if (p?.kind === "ok") {
      expect(p.attempt).toBe(1);
      expect(p.email).toBe("a@x.com");
      expect(p.detail).toBe("imported");
    }
  });

  test("detects OK account legacy detail", () => {
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

  test("detects FAIL PUSH (import failure — must not count as success)", () => {
    const p = parseGrokFarmLogLine("12:34:56  [FAIL]  #1  a@x.com  PUSH:imported=0");
    expect(p?.kind).toBe("fail");
    if (p?.kind === "fail") {
      expect(p.attempt).toBe(1);
      expect(p.email).toBe("a@x.com");
      expect(p.detail).toMatch(/PUSH/i);
    }
  });

  test("parses NDJSON GROK_EVENT ok", () => {
    const p = parseGrokFarmLogLine(
      'GROK_EVENT {"t":"ok","attempt":2,"email":"n@x.com","detail":"imported"}'
    );
    expect(p?.kind).toBe("ok");
    if (p?.kind === "ok") {
      expect(p.attempt).toBe(2);
      expect(p.email).toBe("n@x.com");
      expect(p.detail).toBe("imported");
    }
  });

  test("parses bare NDJSON fail", () => {
    const p = parseGrokFarmLogLine(
      '{"t":"fail","attempt":3,"email":"f@x.com","detail":"PUSH:imported=0"}'
    );
    expect(p?.kind).toBe("fail");
    if (p?.kind === "fail") {
      expect(p.detail).toMatch(/PUSH/i);
    }
  });
});
