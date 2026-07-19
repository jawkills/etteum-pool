import { db } from "./src/db";
import { accounts } from "./src/db/schema";
import { eq } from "drizzle-orm";
import { decrypt } from "./src/utils/crypto";

async function check() {
  console.log("=== BYOK Account Status Check ===\n");
  
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, 1382)
  });
  
  if (!account) {
    console.log("Account #1382 not found");
    return;
  }
  
  console.log("Account Details:");
  console.log(`  ID: ${account.id}`);
  console.log(`  Email: ${account.email}`);
  console.log(`  Provider: ${account.provider}`);
  console.log(`  Status: ${account.status}`);
  console.log(`  Enabled: ${account.enabled}`);
  console.log(`  Last Used: ${account.lastUsedAt}`);
  console.log(`  Last Login: ${account.lastLoginAt}`);
  console.log(`  Updated: ${account.updatedAt}`);
  console.log("");
  
  console.log("Tokens:");
  console.log(JSON.stringify(account.tokens, null, 2));
  console.log("");
  
  console.log("Password (encrypted):");
  console.log(`  ${account.password.substring(0, 50)}...`);
  
  try {
    const decrypted = decrypt(account.password);
    console.log(`  Decrypted: ${decrypted.substring(0, 20)}... (length: ${decrypted.length})`);
  } catch (e) {
    console.log(`  ⚠ Failed to decrypt: ${e}`);
  }
}

check().catch(console.error);
