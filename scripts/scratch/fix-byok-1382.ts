import { db } from "./src/db";
import { accounts } from "./src/db/schema";
import { eq } from "drizzle-orm";

async function fixAccount1382() {
  console.log("Fetching account #1382...");
  
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, 1382)
  });
  
  if (!account) {
    console.log("Account #1382 not found");
    return;
  }
  
  console.log("Current status:", account.status);
  console.log("Current tokens (raw):", account.tokens);
  
  // Parse tokens yang mungkin double-encoded
  let tokens = account.tokens;
  if (typeof tokens === 'string') {
    try {
      // Coba parse sekali
      tokens = JSON.parse(tokens);
      console.log("First parse result:", tokens);
      
      // Kalau masih string, parse lagi (double-encoded)
      if (typeof tokens === 'string') {
        tokens = JSON.parse(tokens);
        console.log("Second parse result (double-decoded):", tokens);
      }
    } catch (e) {
      console.error("Failed to parse tokens:", e);
      return;
    }
  }
  
  // Update account dengan tokens yang sudah di-decode dan status 'active'
  await db.update(accounts)
    .set({
      tokens: tokens,
      status: 'active',
      updatedAt: new Date()
    })
    .where(eq(accounts.id, 1382));
  
  console.log("✅ Account #1382 fixed!");
  console.log("New status: active");
  console.log("Tokens structure:", JSON.stringify(tokens, null, 2));
}

fixAccount1382().catch(console.error);
