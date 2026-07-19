import { getProviderForModel, getByokProvider } from "./src/proxy/providers/registry";
import { db } from "./src/db";
import { accounts } from "./src/db/schema";
import { eq } from "drizzle-orm";

async function testRequest() {
  console.log("=== Testing BYOK Request ===\n");
  
  // Get account
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, 1382)
  });
  
  if (!account) {
    console.log("Account #1382 not found");
    return;
  }
  
  console.log("Account status before request:", account.status);
  console.log("");
  
  // Get provider
  const byokProvider = getByokProvider();
  
  // Test with a simple request
  const testRequest = {
    model: "genflow-gpt-5.4",
    messages: [
      { role: "user" as const, content: "Say 'hello'" }
    ],
    max_tokens: 10
  };
  
  console.log("Sending test request:");
  console.log(`  Model: ${testRequest.model}`);
  console.log(`  Base URL: ${(account.tokens as any).base_url}`);
  console.log("");
  
  try {
    const result = await byokProvider.chatCompletion(account, testRequest);
    
    console.log("Result:");
    console.log(`  Success: ${result.success}`);
    if (result.success) {
      console.log(`  Response: ${JSON.stringify(result.response).substring(0, 100)}...`);
      console.log(`  Tokens: ${result.tokensUsed}`);
    } else {
      console.log(`  Error: ${result.error}`);
    }
  } catch (e) {
    console.log(`  Exception: ${e}`);
  }
  
  // Check status after
  const updatedAccount = await db.query.accounts.findFirst({
    where: eq(accounts.id, 1382)
  });
  console.log("");
  console.log("Account status after request:", updatedAccount?.status);
}

testRequest().catch(console.error);
