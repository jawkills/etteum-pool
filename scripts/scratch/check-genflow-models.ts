import { decrypt } from "./src/utils/crypto";
import { db } from "./src/db";
import { accounts } from "./src/db/schema";
import { eq } from "drizzle-orm";

async function checkModels() {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, 1382)
  });
  
  if (!account) return;
  
  const tokens = account.tokens as any;
  const apiKey = decrypt(account.password);
  
  console.log(`GET ${tokens.base_url.replace(/\/$/, "")}/models\n`);
  
  const response = await fetch(`${tokens.base_url.replace(/\/$/, "")}/models`, {
    headers: { "Authorization": `Bearer ${apiKey}` }
  });
  
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    const models = json.data || json.models || json;
    
    if (Array.isArray(models)) {
      console.log(`Total models: ${models.length}\n`);
      for (const m of models) {
        const id = m.id || m.name || m;
        console.log(`  - ${id}`);
      }
    } else {
      console.log(JSON.stringify(json, null, 2).substring(0, 2000));
    }
  } catch {
    console.log("Raw response:", text.substring(0, 1000));
  }
}

checkModels().catch(console.error);
