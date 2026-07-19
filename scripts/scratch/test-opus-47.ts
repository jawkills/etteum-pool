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
  
  // Test dengan claude-opus-4.7
  const body = {
    model: "claude-opus-4.7",
    messages: [{ role: "user", content: "Say hello" }],
    max_tokens: 10,
    stream: false
  };
  
  console.log(`Testing: claude-opus-4.7\n`);
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body)
  });
  
  console.log(`Status: ${response.status}`);
  const text = await response.text();
  
  // Parse SSE
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const payload = line.slice(6).trim();
      if (payload !== "[DONE]" && !payload.startsWith(":")) {
        try {
          const json = JSON.parse(payload);
          if (json.error) {
            console.log(`Error: ${json.error.message}`);
          } else if (json.choices) {
            console.log(`Success! Response: "${json.choices[0]?.message?.content}"`);
          } else {
            console.log(JSON.stringify(json, null, 2).substring(0, 300));
          }
        } catch {
          console.log("Raw:", payload.substring(0, 200));
        }
      }
    }
  }
}

test().catch(console.error);
