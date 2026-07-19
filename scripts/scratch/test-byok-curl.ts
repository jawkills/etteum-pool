import { decrypt } from "./src/utils/crypto";
import { db } from "./src/db";
import { accounts } from "./src/db/schema";
import { eq } from "drizzle-orm";

async function testCurl() {
  console.log("=== Testing BYOK API with Direct Fetch ===\n");
  
  // Get account
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, 1382)
  });
  
  if (!account) {
    console.log("Account #1382 not found");
    return;
  }
  
  const tokens = account.tokens as any;
  const apiKey = decrypt(account.password);
  const url = `${tokens.base_url.replace(/\/$/, "")}/chat/completions`;
  
  console.log("Request Details:");
  console.log(`  URL: ${url}`);
  console.log(`  API Key: ${apiKey.substring(0, 20)}... (length: ${apiKey.length})`);
  console.log(`  Model: genflow-gpt-5.4 (will be stripped to: gpt-5.4)`);
  console.log("");
  
  const body = {
    model: "gpt-5.4",
    messages: [{ role: "user", content: "Say hello" }],
    max_tokens: 10,
    stream: false
  };
  
  console.log("Sending request...");
  
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body)
    });
    
    console.log(`  Status: ${response.status} ${response.statusText}`);
    console.log(`  Headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
    console.log("");
    
    const text = await response.text();
    console.log("Response Body:");
    console.log(text.substring(0, 500));
    
    if (text.length > 500) {
      console.log(`... (${text.length} total chars)`);
    }
    
    console.log("");
    
    // Try to parse as JSON
    try {
      const json = JSON.parse(text);
      console.log("Parsed as JSON: ✓");
      console.log(JSON.stringify(json, null, 2).substring(0, 300));
    } catch (e) {
      console.log(`Parsed as JSON: ✗ (${e})`);
    }
    
  } catch (e) {
    console.log(`Fetch Error: ${e}`);
  }
}

testCurl().catch(console.error);
