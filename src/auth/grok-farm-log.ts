/**
 * Pure log protocol for scripts/grok-farm/http_farm.py (GROK_UI=log).
 * Shared by farm + reauth supervisors.
 *
 * Preferred: NDJSON events `{"t":"ok",...}` (prefix optional `GROK_EVENT `).
 * Fallback: human log lines `[OK]` / `[FAIL]` / summary.
 */

export type GrokFarmLogParse =
  | { kind: "summary"; success: number; failed: number; pushFailures?: number }
  | { kind: "batch_dir"; batchDir: string }
  | { kind: "step"; attempt: number; email?: string; step: string; detail?: string }
  | { kind: "ok"; attempt: number; email?: string; detail?: string }
  | { kind: "fail"; attempt: number; email?: string; detail?: string }
  | { kind: "progress"; message: string }
  | null;

function parseGrokFarmNdjson(line: string): GrokFarmLogParse {
  let s = line.trim();
  if (s.startsWith("GROK_EVENT ")) s = s.slice("GROK_EVENT ".length).trim();
  if (!s.startsWith("{") || !s.includes('"t"')) return null;
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    const t = String(o.t || o.type || "");
    if (t === "ok") {
      return {
        kind: "ok",
        attempt: Number(o.attempt) || 0,
        email: typeof o.email === "string" ? o.email : undefined,
        detail: typeof o.detail === "string" ? o.detail : undefined,
      };
    }
    if (t === "fail") {
      return {
        kind: "fail",
        attempt: Number(o.attempt) || 0,
        email: typeof o.email === "string" ? o.email : undefined,
        detail: typeof o.detail === "string" ? o.detail : typeof o.error === "string" ? o.error : undefined,
      };
    }
    if (t === "step") {
      return {
        kind: "step",
        attempt: Number(o.attempt) || 0,
        email: typeof o.email === "string" ? o.email : undefined,
        step: typeof o.step === "string" ? o.step : "progress",
        detail: typeof o.detail === "string" ? o.detail : undefined,
      };
    }
    if (t === "batch" || t === "batch_dir") {
      const dir = String(o.dir || o.batchDir || o.batch_dir || "");
      if (!dir) return null;
      return { kind: "batch_dir", batchDir: dir };
    }
    if (t === "summary") {
      return {
        kind: "summary",
        success: Number(o.success ?? o.ok) || 0,
        failed: Number(o.failed ?? o.fail) || 0,
        pushFailures:
          o.pushFailures != null || o.push_fail != null
            ? Number(o.pushFailures ?? o.push_fail) || 0
            : undefined,
      };
    }
    if (t === "progress" || t === "info") {
      return {
        kind: "progress",
        message: String(o.message || o.msg || "").slice(0, 300),
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Parse http_farm.py log lines (NDJSON first, then human format):
 *   {"t":"ok","attempt":1,"email":"a@x.com","detail":"imported"}
 *   12:34:56  [OK]  #1  user@x.com  imported
 *   [BATCH] dir=...
 *    OK 3  FAIL 1  PUSH_FAIL 0  TOTAL 5  OUT ...
 *
 * With dashboard push, [OK] means farmed+imported. Push failures emit [FAIL] PUSH:...
 */
export function parseGrokFarmLogLine(line: string): GrokFarmLogParse {
  const s = line.trim();
  if (!s) return null;

  const nd = parseGrokFarmNdjson(s);
  if (nd) return nd;

  let m = s.match(/OK\s+(\d+)\s+FAIL\s+(\d+)(?:\s+PUSH_FAIL\s+(\d+))?/i);
  if (m && !s.includes("[OK]")) {
    return {
      kind: "summary",
      success: Number(m[1]),
      failed: Number(m[2]),
      pushFailures: m[3] != null ? Number(m[3]) : undefined,
    };
  }

  m = s.match(/\[BATCH\]\s*dir=(.+)/i);
  if (m) return { kind: "batch_dir", batchDir: m[1]!.trim() };

  m = s.match(/\[STEP\]\s*#(\d+)(?:\s+(\S+@\S+))?(?:\s+(.+))?$/i);
  if (m) {
    return {
      kind: "step",
      attempt: Number(m[1]),
      email: m[2] || undefined,
      step: (m[3] || "progress").trim(),
      detail: m[3]?.trim(),
    };
  }

  m = s.match(/\[OK\]\s*#(\d+)(?:\s+(\S+@\S+))?(?:\s+(.+))?$/i);
  if (m) {
    return {
      kind: "ok",
      attempt: Number(m[1]),
      email: m[2] || undefined,
      detail: m[3]?.trim(),
    };
  }

  m = s.match(/\[FAIL\]\s*#(\d+)(?:\s+(\S+@\S+))?(?:\s+(.+))?$/i);
  if (m) {
    return {
      kind: "fail",
      attempt: Number(m[1]),
      email: m[2] || undefined,
      detail: m[3]?.trim(),
    };
  }

  if (/ERROR:|etteum preflight|push fail|spawn error/i.test(s)) {
    return { kind: "progress", message: s.slice(0, 300) };
  }

  return null;
}
