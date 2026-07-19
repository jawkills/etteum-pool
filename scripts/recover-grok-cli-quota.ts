/**
 * One-shot recovery: re-probe grok-cli accounts that WarmUp mass-exhausted
 * because the probe body sent model "grok-4" (rejected by center for every
 * free/personal team with 402 spending-limit).
 *
 * For each exhausted grok-cli account:
 *   - probe center with the real catalog upstream model (grok-4.5)
 *   - HTTP 200 + x-ratelimit-*  -> reactivate, mirror header quota
 *   - HTTP 402 / 429 exhausted   -> leave exhausted (truth)
 *   - HTTP 401/403 auth/revoked  -> leave as-is, mark error
 *   - network error              -> skip (leave as-is, next WarmUp will retry)
 *
 * Usage: bun scripts/recover-grok-cli-quota.ts [--limit N] [--concurrency C] [--dry-run]
 */
import { db } from "../src/db/index.ts";
import { accounts } from "../src/db/schema.ts";
import { eq, and } from "drizzle-orm";
import {
  grokProvider,
  resolveGrokCliUpstreamModel,
} from "../src/proxy/providers/grok-cli";

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 0 : 0;
const concIdx = args.indexOf("--concurrency");
const concurrency = concIdx >= 0 ? Number(args[concIdx + 1]) || 8 : 8;
const dryRun = args.includes("--dry-run");

const PROBE_MODEL = resolveGrokCliUpstreamModel("grok-4.5");
if (PROBE_MODEL !== "grok-4.5") {
  console.error(`abort: catalog upstream resolved to "${PROBE_MODEL}", expected grok-4.5`);
  process.exit(1);
}

const rows = await db
  .select()
  .from(accounts)
  .where(and(eq(accounts.provider, "grok"), eq(accounts.status, "exhausted")))
  .limit(limit || 100_000);

console.log(
  `recover grok-cli: target=${rows.length} model=${PROBE_MODEL} concurrency=${concurrency}${dryRun ? " [DRY-RUN]" : ""}`
);

let ok = 0;
let stillExhausted = 0;
let authFail = 0;
let other = 0;

// Simple bounded concurrency runner.
async function worker(queue: typeof rows): Promise<void> {
  while (queue.length) {
    const account = queue.shift();
    if (!account) return;
    try {
      const quota = await grokProvider.fetchQuota(account);
      const q = quota.quota;
      const exhausted =
        quota.exhausted === true ||
        (q != null && Number(q.remaining) <= 0 && Number(q.limit) > 0);

      if (!quota.success) {
        other++;
        console.log(
          `[${account.id}] skip: ${quota.error || "quota probe failed"}`
        );
        continue;
      }

      if (exhausted) {
        stillExhausted++;
        // Already exhausted; refresh quota numbers if center gave any.
        if (q && !dryRun) {
          await db
            .update(accounts)
            .set({
              quotaLimit: q.limit,
              quotaRemaining: 0,
              updatedAt: new Date(),
            })
            .where(eq(accounts.id, account.id));
        }
        continue;
      }

      // Recovered.
      ok++;
      if (dryRun) {
        console.log(
          `[${account.id}] would reactivate remaining=${q?.remaining}/${q?.limit} source=${q?.source}`
        );
        continue;
      }
      await db
        .update(accounts)
        .set({
          status: "active",
          quotaLimit: q?.limit ?? account.quotaLimit,
          quotaRemaining: q?.remaining ?? account.quotaLimit ?? 0,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, account.id));
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 120);
      // Don't blanket-reactivate on errors — leave for next WarmUp.
      if (/401|403|invalid_grant|revoked/i.test(msg)) {
        authFail++;
        if (!dryRun) {
          await db
            .update(accounts)
            .set({ errorMessage: msg, updatedAt: new Date() })
            .where(eq(accounts.id, account.id));
        }
      } else {
        other++;
      }
      console.log(`[${account.id}] error: ${msg}`);
    }
  }
}

const queue = [...rows];
await Promise.all(
  Array.from({ length: Math.min(concurrency, rows.length) }, () => worker(queue))
);

console.log(
  `\nresult: recovered=${ok} stillExhausted=${stillExhausted} authFail=${authFail} other=${other} / total=${rows.length}${dryRun ? " [DRY-RUN]" : ""}`
);
