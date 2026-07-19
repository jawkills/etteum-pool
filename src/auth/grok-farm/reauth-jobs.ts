/**
 * Pure-ish job materialization for grok-cli reauth (email+password list).
 */

import { eq, inArray } from "drizzle-orm";
import { db } from "../../db/index";
import { accounts } from "../../db/schema";
import { decrypt } from "../../utils/crypto";
import { isPermanentRevocation, isPlaceholderPassword } from "../../proxy/account-health";

export type GrokReauthJob = { email: string; password: string };

function resolvePassword(account: { password: string; email: string }): string | null {
  try {
    const plain = decrypt(account.password);
    if (isPlaceholderPassword(plain)) return null;
    return plain;
  } catch {
    return null;
  }
}

/**
 * Build reauth jobs from DB (dead/error with stored password) or explicit ids.
 */
export async function resolveGrokReauthJobs(opts: {
  ids?: number[];
  onlyDead?: boolean;
  defaultPassword?: string;
}): Promise<{
  jobs: GrokReauthJob[];
  skipped: Array<{ id: number; email: string; reason: string }>;
}> {
  const skipped: Array<{ id: number; email: string; reason: string }> = [];
  let rows =
    opts.ids && opts.ids.length > 0
      ? await db
          .select()
          .from(accounts)
          .where(inArray(accounts.id, opts.ids.map(Number).filter(Number.isFinite)))
      : await db.select().from(accounts).where(eq(accounts.provider, "grok-cli"));

  rows = rows.filter((r) => r.provider === "grok-cli");

  if (opts.onlyDead !== false && !(opts.ids && opts.ids.length > 0)) {
    rows = rows.filter(
      (r) =>
        r.status === "error" ||
        isPermanentRevocation(r.errorMessage) ||
        (r.errorMessage || "").toLowerCase().includes("invalid_grant")
    );
  }

  const jobs: GrokReauthJob[] = [];
  const defaultPw = (opts.defaultPassword || process.env.GROK_PASSWORD || "").trim();

  for (const r of rows) {
    let pw = resolvePassword(r);
    if (!pw && defaultPw) pw = defaultPw;
    if (!pw) {
      skipped.push({
        id: r.id,
        email: r.email,
        reason: "no stored password (re-farm or import with password first)",
      });
      continue;
    }
    jobs.push({ email: r.email, password: pw });
  }

  return { jobs, skipped };
}
