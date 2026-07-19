import { decrypt } from "./src/utils/crypto";
import { db } from "./src/db";
import { accounts } from "./src/db/schema";
import { eq } from "drizzle-orm";

async function test() {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, 1382)
  });
  
  if (!account) return;
  
  const tokens = account.tokens as any;
  const apiKey = decrypt(account.password);
  const url = `${tokens.base_url.replace(/\/$/, "")}/chat/completions`;
  
  const body = {
    model: "claude-opus-4.6",
    messages: [{ role: "user", content: "Say hello" }],
    max_tokens: 10,
    stream: false
  };
  
  console.log(`POST ${url}`);
  console.log(`Model: claude-opus-4.6\n`);
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body)
  });
  
  console.log(`Status: ${response.status}`);
  console.log(`Content-Type: ${response.headers.get("content-type")}`);
  
  const text = await response.text();
  console.log(`\nRaw Response:\n${text.substring(0, 1000)}`);
  
  // Try parse
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    console.log("\n--- SSE Parsing ---");
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const payload = line.slice(6).trim();
        if (payload !== "[DONE]" && !payload.startsWith(":")) {
          try {
            const json = JSON.parse(payload);
            console.log(JSON.stringify(json, null, 2).substring(0, 500));
          } catch {
            console.log("Raw:", payload.substring(0, 200));
          }
        }
      }
    }
  }
}

test().catch(console.error);
