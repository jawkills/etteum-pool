import { db } from "./src/db";
import { accounts } from "./src/db/schema";
import { eq } from "drizzle-orm";

async function resetAccount() {
  await db.update(accounts)
    .set({ status: "active" })
    .where(eq(accounts.id, 1382));
  
  console.log("✓ Account #1382 status reset to active");
}

resetAccount().catch(console.error);
