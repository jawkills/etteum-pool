import { db } from "./src/db/index";
import { accounts } from "./src/db/schema";
import { eq } from "drizzle-orm";
import { openApiHeaders, encodeQoderPayload, signatureHeaders } from "./src/proxy/providers/qoder";

const QOTA_USAGE_URL = "https://openapi.qoder.sh/api/v2/quota/usage";
const JOB_TOKEN_URL = "https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1";

async function checkQuota() {
  const rows = await db.select().from(accounts).where(eq(accounts.provider, "qoder"));
  
  for (const acc of rows) {
    let tokens: any;
    try {
      tokens = typeof acc.tokens === "string" ? JSON.parse(acc.tokens) : acc.tokens;
    } catch {
      console.log(`${acc.email}: can't parse tokens`);
      continue;
    }
    
    if (!tokens?.personalToken) {
      console.log(`${acc.email}: no personalToken`);
      continue;
    }
    
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
      
      if (!resp.ok) {
        console.log(`${acc.email}: auth refresh failed ${resp.status}`);
        continue;
      }
      
      const jt = await resp.json() as any;
      const oauth = jt.securityOauthToken || tokens.securityOauthToken;
      
      if (!oauth) {
        console.log(`${acc.email}: no oauth token after refresh`);
        continue;
      }
      
      const qResp = await fetch(QOTA_USAGE_URL, {
        method: "GET",
        headers: openApiHeaders(oauth),
      });
      
      if (!qResp.ok) {
        console.log(`${acc.email}: quota check failed ${qResp.status}`);
        continue;
      }
      
      const data = await qResp.json() as any;
      const quota = data.userQuota || {};
      const plan = jt.plan || tokens.plan || "unknown";
      
      console.log(`${acc.email} | plan: ${plan} | used: ${quota.used || 0}/${quota.total || 0} | remaining: ${quota.remaining || 0}`);
    } catch (e) {
      console.log(`${acc.email}: error - ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  
  process.exit(0);
}

checkQuota();
