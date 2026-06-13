#!/usr/bin/env bash
# End-to-end test: kirim REAL HTTP request ke proxy, satu skenario per teknik.
# Tidak benar-benar memanggil upstream (kita gunakan model fake yang akan error
# tapi tetap melewati pipeline compression dan dilog ke DB).

set -e
BASE="http://localhost:1930"
DB="data/poolprox3.db"

# Capture max ID before test for clean diff
START_ID=$(sqlite3 "$DB" "SELECT COALESCE(MAX(id),0) FROM request_logs;")
echo "Starting from request id > $START_ID"
echo

post_anthropic() {
  local label="$1"; local payload="$2"
  echo "→ $label"
  curl -s -X POST "$BASE/v1/messages" \
    -H "Content-Type: application/json" \
    -H "x-api-key: sk-pool-8R8S9978ZBZHbXshpRjtfIHGmqA5BnmF" \
    -H "anthropic-version: 2023-06-01" \
    -d "$payload" -o /dev/null -w "  HTTP %{http_code}\n" || true
  sleep 0.4
}

post_openai() {
  local label="$1"; local payload="$2"
  echo "→ $label"
  curl -s -X POST "$BASE/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer sk-pool-8R8S9978ZBZHbXshpRjtfIHGmqA5BnmF" \
    -d "$payload" -o /dev/null -w "  HTTP %{http_code}\n" || true
  sleep 0.4
}

# === T1: TSC trigger (Anthropic flavor with $schema) ===
post_anthropic "T1 TSC" "$(python3 -c '
import json
tools = [{
  "name": f"tool_{i}",
  "description": "Does    something    cool.\n\n\n\nMore  text  here.",
  "input_schema": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$id": f"tool_{i}",
    "type": "object",
    "additionalProperties": False,
    "properties": {"x": {"type": "string"}},
  },
} for i in range(15)]
print(json.dumps({
  "model": "claude-sonnet-4-5",
  "max_tokens": 100,
  "tools": tools,
  "messages": [{"role": "user", "content": "test"}],
}))
')"

# === T2: RTK trigger (Anthropic large tool_result older turn) ===
post_anthropic "T2 RTK Anthropic" "$(python3 -c '
import json
big = "x" * 12000
print(json.dumps({
  "model": "claude-sonnet-4-5",
  "max_tokens": 100,
  "messages": [
    {"role": "user", "content": "do"},
    {"role": "assistant", "content": [{"type": "tool_use", "id": "u1", "name": "Bash", "input": {}}]},
    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "u1", "content": big}]},
    {"role": "assistant", "content": "done"},
    {"role": "user", "content": "more"},
    {"role": "assistant", "content": [{"type": "tool_use", "id": "u2", "name": "Bash", "input": {}}]},
    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "u2", "content": "ok"}]},
    {"role": "assistant", "content": "done"},
  ],
}))
')"

# === T3: RTK trigger (OpenAI role:tool) ===
post_openai "T3 RTK OpenAI" "$(python3 -c '
import json
big = "x" * 12000
print(json.dumps({
  "model": "gpt-5",
  "max_tokens": 100,
  "messages": [
    {"role": "user", "content": "do"},
    {"role": "assistant", "content": None, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "bash", "arguments": "{}"}}]},
    {"role": "tool", "tool_call_id": "c1", "content": big},
    {"role": "assistant", "content": "done"},
    {"role": "user", "content": "more"},
    {"role": "assistant", "content": None, "tool_calls": [{"id": "c2", "type": "function", "function": {"name": "bash", "arguments": "{}"}}]},
    {"role": "tool", "tool_call_id": "c2", "content": "ok"},
    {"role": "assistant", "content": "done"},
  ],
}))
')"

# === T4: DCP trigger (2x identical Read) ===
post_anthropic "T4 DCP" "$(python3 -c '
import json
big = "x" * 3000
print(json.dumps({
  "model": "claude-sonnet-4-5",
  "max_tokens": 100,
  "messages": [
    {"role": "user", "content": "read"},
    {"role": "assistant", "content": [{"type": "tool_use", "id": "r1", "name": "Read", "input": {"file_path": "/test.ts"}}]},
    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "r1", "content": big}]},
    {"role": "assistant", "content": "got it"},
    {"role": "user", "content": "again"},
    {"role": "assistant", "content": [{"type": "tool_use", "id": "r2", "name": "Read", "input": {"file_path": "/test.ts"}}]},
    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "r2", "content": big}]},
    {"role": "assistant", "content": "done"},
  ],
}))
')"

# === T5: Caveman trigger (heavy system prompt) ===
post_anthropic "T5 Caveman" "$(python3 -c '
import json
sys_msg = "You are a    helpful AI assistant.\n\n\n\nPlease very carefully and thoroughly think step by step. " + "It is very important that you are precise. " * 80
print(json.dumps({
  "model": "claude-sonnet-4-5",
  "max_tokens": 100,
  "system": sys_msg,
  "messages": [{"role": "user", "content": "hi"}],
}))
')"

# === T6: Image Dedupe trigger ===
post_anthropic "T6 Image Dedupe" "$(python3 -c '
import json
fake = "B" * 3000
img = {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": fake}}
print(json.dumps({
  "model": "claude-sonnet-4-5",
  "max_tokens": 100,
  "messages": [
    {"role": "user", "content": [img, {"type": "text", "text": "look"}]},
    {"role": "assistant", "content": "ok"},
    {"role": "user", "content": [img, {"type": "text", "text": "again"}]},
  ],
}))
')"

# === T7: Cache markers (stable system) ===
post_anthropic "T7 Cache Markers" "$(python3 -c '
import json
sys_msg = "You are a senior software engineer. " * 40
print(json.dumps({
  "model": "claude-sonnet-4-5",
  "max_tokens": 100,
  "system": sys_msg,
  "messages": [{"role": "user", "content": "hi"}],
}))
')"

echo
echo "Wait 2s for log flush..."
sleep 2

echo
echo "=== Captured request_logs (id > $START_ID) ==="
sqlite3 -header -column "$DB" "
SELECT id,
  substr(model, 1, 18) AS model,
  substr(status, 1, 8) AS status,
  json_extract(compression_stats, '\$.byTechnique.tsc')         AS tsc,
  json_extract(compression_stats, '\$.byTechnique.rtk')         AS rtk,
  json_extract(compression_stats, '\$.byTechnique.dcp')         AS dcp,
  json_extract(compression_stats, '\$.byTechnique.caveman')     AS cav,
  json_extract(compression_stats, '\$.byTechnique.imageDedupe') AS img,
  json_extract(compression_stats, '\$.saved')                   AS saved
FROM request_logs WHERE id > $START_ID ORDER BY id;
"
