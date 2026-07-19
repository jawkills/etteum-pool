import { getByokProvider } from "./src/proxy/providers/registry";
import { db } from "./src/db";
import { accounts } from "./src/db/schema";
import { eq } from "drizzle-orm";

async function test() {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, 1382)
  });
  
  if (!account) { console.log("Account not found"); return; }
  
  const byokProvider = getByokProvider();
  
  console.log("Testing: genflow-claude-opus-4.6");
  console.log(`Status account: ${account.status}\n`);
  
  const result = await byokProvider.chatCompletion(account, {
    model: "genflow-claude-opus-4.6",
    messages: [{ role: "user", content: "Say 'hello' in one word" }],
    max_tokens: 10,
  });
  
  console.log(`Success: ${result.success}`);
  if (result.success) {
    const content = result.response?.choices?.[0]?.message?.content;
    console.log(`Response: "${content}"`);
    console.log(`Tokens: ${result.tokensUsed}`);
  } else {
    console.log(`Error: ${result.error}`);
  }
}

test().catch(console.error);
