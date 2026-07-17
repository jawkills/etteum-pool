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
    expect(p?.success).toBe(3);
    expect(p?.failed).toBe(1);
  });

  test("detects batch dir", () => {
    const p = parseGrokFarmLogLine("[BATCH] dir=C:\\farm\\results\\batch_abc");
    expect(p?.kind).toBe("batch_dir");
    expect(p?.batchDir).toContain("batch_abc");
  });
});
