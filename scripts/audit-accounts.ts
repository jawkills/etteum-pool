#!/usr/bin/env bun
/**
 * Read-only accounts / pool health audit.
 *
 * Usage:
 *   bun scripts/audit-accounts.ts
 *   bun scripts/audit-accounts.ts --json
 *   bun scripts/audit-accounts.ts --provider grok-cli
 *   bun scripts/audit-accounts.ts --samples 10
 *   bun scripts/audit-accounts.ts --lead-minutes 45
 *
 * Does NOT call upstream, mutate DB, or print secrets (tokens redacted).
 * Classification reuses src/proxy/account-health.ts (same rules as runtime).
 */

import { Database } from "bun:sqlite";
import { resolve } from "path";
import {
  classifyOfflineAccount,
  inspectTokens,
  type OfflineAccountClass,
} from "../src/proxy/account-health";

type Args = {
  json: boolean;
  provider: string | null;
  samples: number;
  leadMinutes: number;
  dbPath: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    json: false,
    provider: null,
    samples: 8,
    leadMinutes: 45,
    dbPath: process.env.DATABASE_PATH || resolve(process.cwd(), "data/poolprox3.db"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") args.json = true;
    else if (a === "--provider") args.provider = String(argv[++i] || "").trim() || null;
    else if (a === "--samples") args.samples = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--lead-minutes") args.leadMinutes = Math.max(0, Number(argv[++i]) || 45);
    else if (a === "--db") args.dbPath = String(argv[++i] || args.dbPath);
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: bun scripts/audit-accounts.ts [options]
  --json              Machine-readable output
  --provider <name>   Filter one provider
  --samples <n>       Sample rows per bucket (default 8)
  --lead-minutes <n>  Fresh if expires_at - now >= n minutes (default 45)
  --db <path>         SQLite path (default DATABASE_PATH or data/poolprox3.db)`);
      process.exit(0);
    }
  }
  return args;
}

type Row = {
  id: number;
  provider: string;
  email: string;
  status: string;
  enabled: number;
  error_message: string | null;
  tokens: unknown;
  last_used_at: number | string | null;
  last_login_at: number | string | null;
};

type Sample = { id: number; email: string; detail: string };

type ProviderReport = {
  provider: string;
  total: number;
  enabled: number;
  disabled: number;
  byStatus: Record<string, number>;
  /** enabled + status active */
  dbActive: number;
  tokenFresh: number;
  tokenExpired: number;
  tokenUnknown: number;
  noToken: number;
  /** status=error (any cause) */
  errorStatus: number;
  /** error_message looks permanently dead (invalid_grant, revoked, …) */
  revokedLooking: number;
  /** Best-effort "can serve traffic" (includes refreshable expired access) */
  usable: number;
  usablePctOfEnabled: number;
  /** usable subset: expired access but has refresh + not revoked-looking */
  refreshable: number;
  /** db active but not usable */
  zombieActive: number;
  samples: {
    usable: Sample[];
    refreshable: Sample[];
    zombieActive: Sample[];
    revokedLooking: Sample[];
    errorStatus: Sample[];
  };
};

function pad(s: string, n: number) {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function fmtMinutes(secondsLeft: number | null): string {
  if (secondsLeft == null) return "";
  const m = Math.round(Math.abs(secondsLeft) / 60);
  return secondsLeft >= 0 ? `${m}m left` : `${m}m past lead`;
}

function sampleDetail(cls: OfflineAccountClass, errorMessage: string | null): string {
  if (cls.revokedLooking) {
    return `revoked msg: ${String(errorMessage || "").slice(0, 60)}`;
  }
  if (cls.refreshable) {
    const age = fmtMinutes(cls.secondsLeft);
    return age ? `refreshable (access expired, ${age})` : "refreshable (access expired)";
  }
  if (cls.freshness === "fresh") {
    const left = fmtMinutes(cls.secondsLeft);
    return left ? `access fresh ~${left}` : "access fresh";
  }
  if (cls.freshness === "no_token") return "no token";
  if (cls.freshness === "expired") {
    const age = fmtMinutes(cls.secondsLeft);
    return age ? `expired, no refresh (${age})` : "expired, no refresh";
  }
  return "active, expiry unknown";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const leadSec = args.leadMinutes * 60;
  const nowSec = Math.floor(Date.now() / 1000);

  const db = new Database(args.dbPath, { readonly: true });
  let rows = db
    .query(
      `SELECT id, provider, email, status, enabled, error_message, tokens, last_used_at, last_login_at
       FROM accounts
       ORDER BY provider, id`
    )
    .all() as Row[];

  if (args.provider) {
    rows = rows.filter((r) => r.provider === args.provider);
  }

  const byProvider = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byProvider.get(r.provider) || [];
    list.push(r);
    byProvider.set(r.provider, list);
  }

  const reports: ProviderReport[] = [];

  for (const [provider, list] of [...byProvider.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const byStatus: Record<string, number> = {};
    let enabled = 0;
    let disabled = 0;
    let dbActive = 0;
    let tokenFresh = 0;
    let tokenExpired = 0;
    let tokenUnknown = 0;
    let noToken = 0;
    let errorStatus = 0;
    let revokedLooking = 0;
    let usable = 0;
    let refreshable = 0;
    let zombieActive = 0;

    const samplesUsable: Sample[] = [];
    const samplesRefreshable: Sample[] = [];
    const samplesZombie: Sample[] = [];
    const samplesRevoked: Sample[] = [];
    const samplesError: Sample[] = [];

    for (const r of list) {
      const st = r.status || "unknown";
      byStatus[st] = (byStatus[st] || 0) + 1;

      const cls = classifyOfflineAccount(
        {
          status: r.status,
          enabled: r.enabled,
          errorMessage: r.error_message,
          tokens: r.tokens,
        },
        nowSec,
        leadSec
      );

      // Token freshness counters over all rows (not only active)
      const tok = inspectTokens(r.tokens, nowSec, leadSec);
      if (tok.freshness === "fresh") tokenFresh++;
      else if (tok.freshness === "expired") tokenExpired++;
      else if (tok.freshness === "unknown") tokenUnknown++;
      else noToken++;

      if (cls.enabled) enabled++;
      else disabled++;

      if (cls.errorStatus) {
        errorStatus++;
        if (samplesError.length < args.samples) {
          samplesError.push({
            id: r.id,
            email: r.email,
            detail: String(r.error_message || st).slice(0, 100),
          });
        }
      }

      if (cls.revokedLooking) {
        revokedLooking++;
        if (samplesRevoked.length < args.samples) {
          samplesRevoked.push({
            id: r.id,
            email: r.email,
            detail: String(r.error_message || "revoked").slice(0, 100),
          });
        }
      }

      if (cls.dbActive) {
        dbActive++;
        if (cls.usable) {
          usable++;
          if (samplesUsable.length < args.samples) {
            samplesUsable.push({
              id: r.id,
              email: r.email,
              detail: sampleDetail(cls, r.error_message),
            });
          }
          if (cls.refreshable) {
            refreshable++;
            if (samplesRefreshable.length < args.samples) {
              samplesRefreshable.push({
                id: r.id,
                email: r.email,
                detail: sampleDetail(cls, r.error_message),
              });
            }
          }
        } else {
          zombieActive++;
          if (samplesZombie.length < args.samples) {
            samplesZombie.push({
              id: r.id,
              email: r.email,
              detail: sampleDetail(cls, r.error_message),
            });
          }
        }
      }
    }

    reports.push({
      provider,
      total: list.length,
      enabled,
      disabled,
      byStatus,
      dbActive,
      tokenFresh,
      tokenExpired,
      tokenUnknown,
      noToken,
      errorStatus,
      revokedLooking,
      usable,
      usablePctOfEnabled: enabled > 0 ? Math.round((usable / enabled) * 1000) / 10 : 0,
      refreshable,
      zombieActive,
      samples: {
        usable: samplesUsable,
        refreshable: samplesRefreshable,
        zombieActive: samplesZombie,
        revokedLooking: samplesRevoked,
        errorStatus: samplesError,
      },
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    dbPath: args.dbPath,
    leadMinutes: args.leadMinutes,
    providers: reports,
    totals: {
      accounts: rows.length,
      providers: reports.length,
      usable: reports.reduce((s, r) => s + r.usable, 0),
      refreshable: reports.reduce((s, r) => s + r.refreshable, 0),
      dbActive: reports.reduce((s, r) => s + r.dbActive, 0),
      zombieActive: reports.reduce((s, r) => s + r.zombieActive, 0),
      errorStatus: reports.reduce((s, r) => s + r.errorStatus, 0),
      revokedLooking: reports.reduce((s, r) => s + r.revokedLooking, 0),
    },
    notes: [
      "usable ≈ enabled + status=active + not revoked-looking + (fresh OR refreshable-expired OR unknown-expiry session)",
      "refreshable = usable subset with expired access but present refresh_token (runtime will proactive-refresh)",
      "zombieActive = db active but NOT usable (no token / expired without refresh / revoked-looking msg)",
      "errorStatus = status=error (any cause); revokedLooking = dead-looking error_message (may also be active)",
      "Classification shared with runtime via src/proxy/account-health.ts",
      "This script does not call upstream; true revoke is proven only after refresh attempt",
      "Re-farm is required for revoked refresh tokens — code cannot resurrect them",
    ],
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`\n=== Accounts audit (read-only) ===`);
  console.log(`DB: ${args.dbPath}`);
  console.log(`Time: ${summary.generatedAt}`);
  console.log(`Fresh if expires_at - now >= ${args.leadMinutes}m\n`);

  if (reports.length === 0) {
    console.log("No accounts found.");
    return;
  }

  const cols = [
    ["provider", 14],
    ["total", 7],
    ["enab", 6],
    ["active", 7],
    ["usable", 7],
    ["rfrsh", 6],
    ["zombie", 7],
    ["fresh", 7],
    ["expird", 7],
    ["err", 5],
    ["revok", 6],
    ["use%", 6],
  ] as const;

  console.log(cols.map(([h, w]) => pad(h, w)).join(" "));
  console.log(cols.map(([, w]) => "-".repeat(w)).join(" "));

  for (const r of reports) {
    const line = [
      pad(r.provider, 14),
      pad(String(r.total), 7),
      pad(String(r.enabled), 6),
      pad(String(r.dbActive), 7),
      pad(String(r.usable), 7),
      pad(String(r.refreshable), 6),
      pad(String(r.zombieActive), 7),
      pad(String(r.tokenFresh), 7),
      pad(String(r.tokenExpired), 7),
      pad(String(r.errorStatus), 5),
      pad(String(r.revokedLooking), 6),
      pad(`${r.usablePctOfEnabled}%`, 6),
    ].join(" ");
    console.log(line);
  }

  console.log("\n--- Totals ---");
  console.log(
    `accounts=${summary.totals.accounts}  dbActive=${summary.totals.dbActive}  usable=${summary.totals.usable}  refreshable=${summary.totals.refreshable}  zombieActive=${summary.totals.zombieActive}  errorStatus=${summary.totals.errorStatus}  revokedLooking=${summary.totals.revokedLooking}`
  );

  for (const r of reports) {
    console.log(`\n### ${r.provider}`);
    console.log(`  status breakdown: ${JSON.stringify(r.byStatus)}`);
    console.log(
      `  tokens: fresh=${r.tokenFresh} expired=${r.tokenExpired} unknown=${r.tokenUnknown} none=${r.noToken}`
    );
    console.log(
      `  usable=${r.usable} (of which refreshable=${r.refreshable})  zombie=${r.zombieActive}  errorStatus=${r.errorStatus}  revokedLooking=${r.revokedLooking}`
    );
    if (args.samples > 0) {
      const printSamples = (title: string, samples: Sample[]) => {
        if (!samples.length) return;
        console.log(`  ${title}:`);
        for (const s of samples) {
          console.log(`    #${s.id} ${s.email} — ${s.detail}`);
        }
      };
      printSamples("usable samples", r.samples.usable);
      printSamples("refreshable samples", r.samples.refreshable);
      printSamples("zombie active samples", r.samples.zombieActive);
      printSamples("revoked-looking samples", r.samples.revokedLooking);
      printSamples("error-status samples", r.samples.errorStatus);
    }
  }

  console.log("\n--- Notes ---");
  for (const n of summary.notes) console.log(`• ${n}`);
  console.log("");
}

try {
  main();
} catch (err) {
  console.error("audit-accounts failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
