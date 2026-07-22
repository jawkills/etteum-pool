# Grok Nuclear Rebuild — Clean-room Design

**Date:** 2026-07-21  
**Status:** Approved  
**Branch:** `feat/grok-nuclear-rebuild`

## Summary

Delete the existing Grok provider surface entirely and rebuild a clean Build/CLI OAuth provider for etteum-pool. Port algorithms and contracts from [chenyme/grok2api](https://github.com/chenyme/grok2api) **Build/cli** only — not the Go monorepo, not Web SSO/Console.

## Locked decisions

| Decision | Choice |
|----------|--------|
| Approach | Clean-room (delete → greenfield) |
| Surface | Build/CLI OAuth (`cli-chat-proxy.grok.com`) |
| Upstream protocol | Responses API only (`POST /v1/responses`) |
| Features | Thinking, Vision, Image gen/edit, function tools, auto `web_search` + `x_search` |
| Search | Inject built-ins on Build path; graceful degrade if upstream rejects |
| Accounts | Export CPA → wipe → restore/farm |
| Non-goals v1 | Web SSO, Console, Imagine WS, video, paid `api.x.ai` key pool, `gcli/` / `grok-cli` ids |

## Architecture

### Protocols

| Boundary | Protocol |
|----------|----------|
| Client → pool | OpenAI `/v1/chat/completions`, `/v1/messages`, `/v1/images/*`, `/v1/models` |
| Pool → upstream | Responses only |
| Internal router | OpenAI chat; Anthropic is edge-only via shared transform |

### Package layout

```
src/proxy/providers/grok/
  constants.ts
  models.ts
  auth.ts
  headers.ts
  tools.ts
  translate.ts
  wire.ts
  image.ts
  errors.ts
  settings.ts
  index.ts
  *.test.ts
```

### Chat data flow

```
Client OpenAI/Anthropic
  → router + pool account(provider=grok)
  → prepareSession (proactive refresh + lock)
  → tools.enrich (client tools ∪ auto web_search/x_search)
  → translate.toResponses (vision, reasoning effort, max_output)
  → wire POST /v1/responses
  → on 400 unknown tool: one retry without built-ins (searchDegraded)
  → translate.toChat (SSE: text + reasoning_content + tool_calls)
  → ProviderResult flags → account-attempt
```

### Catalog

| Model | thinking | vision | tools | notes |
|-------|----------|--------|-------|-------|
| `grok-4.5` (+ `-low\|medium\|high\|xhigh`) | yes | yes | yes | upstream always `grok-4.5` |
| `grok-4.5-max` | — | — | — | alias → xhigh |
| `grok-image` | no | yes | image path | image_generation tool |

### Settings keys

| Key | Default |
|-----|---------|
| `grok_refresh_lead_sec` | 2700 |
| `grok_max_account_retries` | 8 |
| `grok_auto_web_search` | true |
| `grok_auto_x_search` | true |
| `grok_auto_code_interpreter` | false |

Env uses `GROK_*` only (no public `GROK_CLI_*` names).

### Module contracts

- **auth:** CPA normalize + OAuth refresh; permanent vs temporary failure
- **headers:** cli identity + **stable** session ids (from `prompt_cache_key` or message hash — not random per request)
- **tools:** map OpenAI function tools; strip `type:"custom"`; auto-inject web/x search; dedupe
- **translate:** Chat↔Responses; SSE always finishes with finish_reason + `[DONE]`
- **wire:** free functions, Responses-only chat/image/probe
- **errors:** ordered `dead > exhausted > rate_limited > auth`
- **image:** Responses + `image_generation`; extract `image_generation_call`
- **index:** thin `GrokProvider` — session policy + locks only

### Nuclear delete map

1. Export CPA → `backups/grok-cpa-YYYY-MM-DD.jsonl` (gitignored)
2. Detach registry, image, admin, dashboard, warmup
3. Delete provider package, shims, farm, recover script, grok-specific tests
4. Wipe `accounts WHERE provider='grok'` after export verified
5. Delete orphan `grok_*` / `grok_cli_*` settings
6. Keep request/bot logs; keep shared pool/router/BaseProvider

### Image re-add

- Thin `grok-image-pool.ts`
- `/v1/images/generations|edits` + Image Studio `provider: "grok"`
- n≤4; 180s timeout; no local quota decrement

### Admin re-add

- `POST /api/accounts/grok/import`
- `POST /api/accounts/grok/import-backup` (JSONL restore)
- Settings UI for keys above
- Farm/reauth can follow after chat is green

### Search acceptance

- **Pass:** tools used or silently ignored, chat OK
- **Degrade pass:** 400 unknown tool → retry without built-ins, log `searchDegraded`
- **Fail only if:** chat breaks when search inject is on

### Non-goals / backlog

- Paid `api.x.ai` search key pool
- Web SSO / Imagine / video
- Auto `code_interpreter`
- Multi-instance sticky Redis (use existing pool)

### Success criteria

1. Zero legacy Grok surface before re-add
2. Stream always terminates (no “thinks then dies”)
3. Thinking + vision + function tools + auto search inject
4. Image gen/edit via Responses `image_generation`
5. Accounts restorable from CPA export
6. Public contract: provider id `grok`, OpenAI edge, catalog above
