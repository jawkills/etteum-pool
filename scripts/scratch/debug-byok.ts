import { db } from "./src/db";
import { accounts } from "./src/db/schema";
import { eq } from "drizzle-orm";
import { getByokProvider } from "./src/proxy/providers/registry";

async function debug() {
  console.log("=== Debug BYOK Provider ===\n");
  
  // Check database
  const byokAccounts = await db.query.accounts.findMany({
    where: eq(accounts.provider, "byok")
  });
  
  console.log("BYOK accounts in DB:", byokAccounts.length);
  byokAccounts.forEach(acc => {
    console.log(`  - ID: ${acc.id}, Email: ${acc.email}, Status: ${acc.status}, Enabled: ${acc.enabled}`);
    console.log(`    Tokens:`, acc.tokens);
  });
  
  // Check BYOK provider
  const byokProvider = getByokProvider();
  console.log("\n=== BYOK Provider State ===");
  console.log("Cache expiry:", byokProvider["cacheExpiry"]);
  console.log("Current time:", Date.now());
  console.log("Cache stale:", Date.now() >= byokProvider["cacheExpiry"]);
  console.log("Prefixes:", byokProvider["prefixes"]);
  console.log("Prefix cache size:", byokProvider["prefixCache"].size);
  
  // Force refresh
  console.log("\n=== Force Refresh Cache ===");
  await byokProvider.refreshModelsCache();
  console.log("After refresh - Prefixes:", byokProvider["prefixes"]);
  console.log("After refresh - Cache expiry:", byokProvider["cacheExpiry"]);
  
  // Test ownsModel
  console.log("\n=== Test ownsModel ===");
  const testModels = ["genflow-gpt-5.4", "genflow-claude-opus-4.6"];
  testModels.forEach(model => {
    const owns = byokProvider.ownsModel(model);
    console.log(`  ${model}: ${owns}`);
  });
}

debug().catch(console.error);
