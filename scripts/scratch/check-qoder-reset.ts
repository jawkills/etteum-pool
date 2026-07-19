import { db } from "./src/db/index";
import { accounts } from "./src/db/schema";
import { eq } from "drizzle-orm";
import { openApiHeaders, encodeQoderPayload, signatureHeaders } from "./src/proxy/providers/qoder";

const QOTA_USAGE_URL = "https://openapi.qoder.sh/api/v2/quota/usage";
const JOB_TOKEN_URL = "https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1";

async function checkResetTime() {
  const rows = await db.select().from(accounts).where(eq(accounts.provider, "qoder"));
  
  for (const acc of rows.slice(0, 3)) {
    let tokens: any;
    try {
      tokens = typeof acc.tokens === "string" ? JSON.parse(acc.tokens) : acc.tokens;
    } catch { continue; }
    
    if (!tokens?.personalToken) continue;
    
    try {
      const inner = {
        personalToken: tokens.personalToken,
        securityOauthToken: tokens.securityOauthToken || "",
        refreshToken: tokens.refreshToken || "",
        needRefresh: !!tokens.refreshToken,
        authInfo: {},
      };
      const outer = { payload: JSON.stringify(inner), encodeVersion: "1" };
      const body = encodeQoderPayload(JSON.stringify(outer));
      
      const resp = await fetch(JOB_TOKEN_URL, {
        method: "POST",
        headers: signatureHeaders(tokens),
        body,
      });
      
      if (!resp.ok) continue;
      
      const jt = await resp.json() as any;
      const oauth = jt.securityOauthToken || tokens.securityOauthToken;
      if (!oauth) continue;
      
      const qResp = await fetch(QOTA_USAGE_URL, {
        method: "GET",
        headers: openApiHeaders(oauth),
      });
      
      if (!qResp.ok) continue;
      
      const data = await qResp.json() as any;
      
      console.log(`\n=== ${acc.email} ===`);
      console.log(`Full response:`, JSON.stringify(data, null, 2));
      
      if (data.expiresAt) {
        console.log(`\nexpiresAt (raw): ${data.expiresAt}`);
        console.log(`expiresAt (date): ${new Date(data.expiresAt).toISOString()}`);
        console.log(`expiresAt (local): ${new Date(data.expiresAt).toLocaleString()}`);
      }
      
      if (data.userQuota) {
        console.log(`\nuserQuota:`, JSON.stringify(data.userQuota, null, 2));
      }
      
      // Check all keys for any time-related fields
      const allKeys = Object.keys(data);
      console.log(`\nAll top-level keys: ${allKeys.join(", ")}`);
      
    } catch (e) {
      console.log(`${acc.email}: error - ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  
  process.exit(0);
}

checkResetTime();
