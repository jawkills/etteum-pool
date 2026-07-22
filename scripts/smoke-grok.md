# Grok smoke checklist (post-rebuild)

Run against a live pool after deploy + account restore.

## Preconditions

- Server running with branch `feat/grok-nuclear-rebuild` (or merged main)
- At least 1 active `provider=grok` account
- `API_KEY` set; `BASE` = pool URL (e.g. `http://127.0.0.1:1930`)

```bash
export BASE=http://127.0.0.1:1930
export KEY=pool-proxy-secret-key   # or your API_KEY
```

## 1. Catalog

```bash
curl -sS "$BASE/v1/models" -H "Authorization: Bearer $KEY" | jq '.data[] | select(.id|test("grok")) | .id'
```

Expect: `grok-4.5`, effort suffixes, `grok-image`.

## 2. Stream chat finishes (no “thinks then dies”)

```bash
curl -sS -N "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.5",
    "stream": true,
    "messages": [{"role":"user","content":"Say hi in one short sentence."}]
  }'
```

Expect: content deltas + final `finish_reason` + `data: [DONE]`.

## 3. Thinking / reasoning

```bash
curl -sS -N "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.5-high",
    "stream": true,
    "messages": [{"role":"user","content":"What is 17*19? Think briefly."}]
  }'
```

Expect: some `reasoning_content` deltas and a final answer.

## 4. Vision

```bash
# Use a tiny public image or data URL
curl -sS "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.5",
    "stream": false,
    "messages": [{
      "role": "user",
      "content": [
        {"type":"text","text":"Describe this image in 5 words."},
        {"type":"image_url","image_url":{"url":"https://httpbin.org/image/png"}}
      ]
    }]
  }' | jq '.choices[0].message.content'
```

## 5. Function tools

```bash
curl -sS "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.5",
    "stream": false,
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }],
    "tool_choice": "auto",
    "messages": [{"role":"user","content":"What is the weather in Jakarta? Use the tool."}]
  }' | jq '.choices[0].message'
```

## 6. Auto web/x search inject

Same as (2) with a search-y prompt:

```bash
curl -sS -N "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.5",
    "stream": true,
    "messages": [{"role":"user","content":"What are the latest headlines about xAI today?"}]
  }'
```

Pass if:
- model uses search, **or**
- chat still completes, **or**
- server logs `searchDegraded=true` after unknown-tool retry

Fail only if the request hard-errors solely because search tools were injected.

## 7. Image generation

```bash
curl -sS "$BASE/v1/images/generations" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-image",
    "prompt": "A simple red circle on white background",
    "n": 1
  }' | jq '{created, data_len:(.data|length), has_b64:(.data[0].b64_json!=null)}'
```

## 8. Auth refresh / dead path (optional)

- Force near-expiry token → next request should refresh without 401 to client
- Revoked refresh → account marked dead / `Grok dead:` style error

## Ops restore (if wiped)

```bash
# After export + wipe:
curl -sS "$BASE/api/accounts/grok/import-backup" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d @<(jq -Rs '{text:.}' backups/grok-cpa-YYYY-MM-DD.jsonl)
```
