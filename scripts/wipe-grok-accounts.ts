/**
 * Wipe all Grok accounts + orphan grok_* settings AFTER export is verified.
 *
 * Usage:
 *   bun scripts/wipe-grok-accounts.ts --confirm
 *   bun scripts/wipe-grok-accounts.ts --confirm --keep-settings
 *
 * Safety: refuses to run without --confirm.
 */

import { eq, like, or } from "drizzle-orm";
import { db } from "../src/db/index";
import { accounts, settings } from "../src/db/schema";

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const keepSettings = args.includes("--keep-settings");
  if (!confirm) {
    console.error("Refusing: pass --confirm after verifying CPA export.");
    process.exit(1);
  }

  const rows = await db.select().from(accounts).where(eq(accounts.provider, "grok"));
  console.log(`[wipe-grok] accounts to delete: ${rows.length}`);

  await db.delete(accounts).where(eq(accounts.provider, "grok"));
  console.log("[wipe-grok] accounts deleted");

  if (!keepSettings) {
    await db
      .delete(settings)
      .where(or(like(settings.key, "grok_%"), like(settings.key, "grok_cli_%")));
    console.log("[wipe-grok] orphan grok_* settings cleared");
  } else {
    console.log("[wipe-grok] kept settings (--keep-settings)");
  }

  const left = await db.select().from(accounts).where(eq(accounts.provider, "grok"));
  console.log(`[wipe-grok] remaining grok accounts: ${left.length}`);
  if (left.length !== 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
