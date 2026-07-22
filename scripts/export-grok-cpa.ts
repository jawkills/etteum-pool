/**
 * Export all Grok accounts (CPA/tokens) to a JSONL backup before nuclear wipe.
 *
 * Usage:
 *   bun scripts/export-grok-cpa.ts
 *   bun scripts/export-grok-cpa.ts --out backups/my-export.jsonl
 *
 * Output is gitignored under backups/. Never commit CPA files.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index";
import { accounts } from "../src/db/schema";

function parseArgs(argv: string[]) {
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) {
      out = argv[++i]!;
    }
  }
  return { out };
}

function today(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const outPath =
    out || path.join(process.cwd(), "backups", `grok-cpa-${today()}.jsonl`);

  mkdirSync(path.dirname(outPath), { recursive: true });

  const rows = await db.select().from(accounts).where(eq(accounts.provider, "grok"));
  const lines: string[] = [];

  for (const row of rows) {
    let tokens: any = null;
    try {
      tokens =
        typeof row.tokens === "string"
          ? JSON.parse(row.tokens as string)
          : row.tokens;
    } catch {
      tokens = row.tokens;
    }
    let metadata: any = null;
    try {
      metadata =
        typeof row.metadata === "string"
          ? JSON.parse(row.metadata as string)
          : row.metadata;
    } catch {
      metadata = row.metadata;
    }

    const rec = {
      email: row.email,
      status: row.status,
      enabled: row.enabled,
      expires_at: row.expiresAt ?? null,
      quota_limit: row.quotaLimit ?? null,
      quota_remaining: row.quotaRemaining ?? null,
      tokens: tokens
        ? {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            id_token: tokens.id_token,
            team_id: tokens.team_id,
            sub: tokens.sub,
            user_id: tokens.user_id,
            principal_id: tokens.principal_id,
            token_type: tokens.token_type,
            email: tokens.email || row.email,
            expires_at: tokens.expires_at,
            client_id: tokens.client_id,
          }
        : null,
      metadata: metadata && typeof metadata === "object" ? metadata : undefined,
      exported_at: new Date().toISOString(),
      provider: "grok",
    };
    lines.push(JSON.stringify(rec));
  }

  writeFileSync(outPath, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  console.log(`[export-grok-cpa] wrote ${lines.length} accounts → ${outPath}`);
  console.log(
    `[export-grok-cpa] verify: DB count ${rows.length} == file lines ${lines.length}`
  );
  if (rows.length !== lines.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
