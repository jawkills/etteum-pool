# Qoder Open-Panel Implementation

## Research Findings

### Token Structure
Qoder accounts store these tokens in the database:
- `personalToken` (pt-*): PAT for API access
- `securityOauthToken` (jt-*): OAuth token for API calls
- `refreshToken` (jrt-*): Refresh token for job token exchange
- `machineId`: Device identifier
- `web_cookie`: Full browser cookie string captured after login (33 cookies, ~5KB)

### Web Dashboard Authentication
Qoder uses a traditional web session cookie (`qoder_session_cookie`) for dashboard access:
- Cookie is base64-encoded: `{timestamp}|{encrypted_data}|{signature}`
- Created during OAuth login flow (Google SSO)
- Contains user session state for qoder.com domain
- No refresh token endpoint for web sessions (unlike Kiro)

### Why Different Approach from Kiro?
- **Kiro**: Uses refresh token → inject AccessToken/RefreshToken cookies → opens app.kiro.dev
- **Qoder**: No web session refresh API; uses traditional session cookies → must restore browser cookies

### Cookie Analysis
The `web_cookie` field contains 33 cookies including:
- **Qoder-specific**: `qoder_session_cookie`, `qoder_locale`, `tfstk`, `cbc`
- **Google OAuth**: `SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, etc. (used for SSO)
- **Tracking**: `_ga`, `_gcl_au`, etc.

For dashboard access, we only need qoder.com domain cookies (not Google cookies).

## Implementation

### Approach: Cookie Injection
Modified `/src/api/accounts.ts` line 648-806 to support Qoder:

```typescript
else if (account.provider === "qoder") {
  const webCookie = tokens.web_cookie;
  if (!webCookie) {
    return c.json({ error: "No web_cookie available" }, 400);
  }

  // Parse and filter cookies
  const qoderCookies = webCookie.split("; ")
    .filter(c => {
      const name = c.split("=")[0];
      return name.startsWith("qoder_") || 
             name === "tfstk" || 
             name === "cbc" ||
             name === "test_cookie" ||
             name.startsWith("_ga") ||
             name === "OTZ";
    })
    .map(c => ({
      name: c.split("=")[0],
      value: c.split("=").slice(1).join("="),
      domain: "qoder.com",
      path: "/"
    }));

  // Inject into Playwright browser context
  await context.addCookies(qoderCookies);
  await page.goto("https://qoder.com/account/profile");
}
```

### Key Features
1. **Cookie Filtering**: Only inject qoder.com-relevant cookies (12 cookies)
2. **Domain Targeting**: All cookies set to `qoder.com` domain
3. **Error Handling**: Returns 400 if `web_cookie` is missing
4. **Browser Launch**: Uses Playwright with `headless: false`

## Testing Results

### Success Cases
- Account 361: Browser opened, 12 cookies injected
- Account 333: Browser opened, 11 cookies injected  
- Account 281: Browser opened, 10 cookies injected

### Error Handling
- Account 244 (no web_cookie): Returns 400 "No web_cookie available"
- Account 999 (non-existent): Returns 404 "Account not found"

### API Usage
```bash
curl -X POST http://localhost:1930/api/accounts/361/open-panel \
  -H "Authorization: Bearer sk-pool-P46xteFVfqmF4Hir8omRvSuHfvMKnFae"
```

Response:
```json
{
  "success": true,
  "message": "Browser opened for AbimanaZidanWibisono@gemuel.com",
  "cookiesInjected": 12
}
```

## Limitations

### Session Expiration
- `qoder_session_cookie` expires (typically 24-48 hours)
- No automatic refresh mechanism like Kiro
- Requires re-login to capture fresh cookies

### Future Improvements
1. **Cookie Refresh Hook**: Add to login flow to always capture latest cookies
2. **Session Validation**: Check cookie age before opening panel
3. **Auto-relogin**: Detect expired session and trigger re-auth
4. **Cookie Encryption**: Store cookies encrypted in database

## Comparison: Kiro vs Qoder

| Feature | Kiro | Qoder |
|---------|------|-------|
| Auth Method | OAuth refresh token | Session cookies |
| Token Refresh | Yes (automatic) | No (manual re-login) |
| Cookie Injection | AccessToken, RefreshToken | qoder_session_cookie + others |
| Session Lifetime | Long (refresh token) | Short (24-48h) |
| Dashboard URL | app.kiro.dev | qoder.com |
| Browser Launch | Yes | Yes |

## Files Modified

1. `/src/api/accounts.ts` (lines 648-806)
   - Added Qoder provider branch in open-panel endpoint
   - Implemented cookie parsing and filtering
   - Added error handling for missing web_cookie

2. Database (no schema changes needed)
   - `web_cookie` field already exists in `accounts.tokens` JSON
   - Captured during login via `scripts/auth/login.py:137`
