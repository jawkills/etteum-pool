/**
 * Pure log protocol for scripts/codebuddy-farm/http_farm.py (CODEBUDDY_UI=log).
 */

export type CodeBuddyFarmLogParse =
  | { kind: "summary"; success: number; failed: number; pushFailures?: number }
  | { kind: "batch_dir"; batchDir: string }
  | { kind: "step"; attempt: number; email?: string; step: string; detail?: string }
  | { kind: "ok"; attempt: number; email?: string; detail?: string }
  | { kind: "fail"; attempt: number; email?: string; detail?: string }
  | { kind: "progress"; message: string }
  | null;

function parseNdjson(line: string): CodeBuddyFarmLogParse {
  let s = line.trim();
  if (s.startsWith("CODEBUDDY_EVENT ")) s = s.slice("CODEBUDDY_EVENT ".length).trim();
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
        detail:
          typeof o.detail === "string"
            ? o.detail
            : typeof o.error === "string"
              ? o.error
              : undefined,
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
  } catch {
    return null;
  }
  return null;
}

export function parseCodeBuddyFarmLogLine(line: string): CodeBuddyFarmLogParse {
  const nd = parseNdjson(line);
  if (nd) return nd;

  const s = line.trim();
  let m: RegExpMatchArray | null;

  m = s.match(
    /OK\s+(\d+)\s+FAIL\s+(\d+)(?:\s+PUSH_FAIL\s+(\d+))?/i,
  );
  if (m) {
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

  if (/ERROR:|etteum preflight|push fail|spawn error|HME preflight|solver/i.test(s)) {
    return { kind: "progress", message: s.slice(0, 300) };
  }

  return null;
}
