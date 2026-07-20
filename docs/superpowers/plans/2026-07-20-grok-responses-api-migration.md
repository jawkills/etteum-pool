# 2026-07-20 — Grok: Migrate chat from `/chat/completions` to `/v1/responses`

## Symptom

When testing Grok via opencode (Anthropic SDK consumer), the model would start
thinking (reasoning deltas) and then **terminate without writing any output** —
"thinks then dies". The same account worked fine through 9router.

## Root cause

The Grok CLI chat upstream (`cli-chat-proxy.grok.com`) deprecated the legacy
`/v1/chat/completions` path for interactive sessions. Calls on that path now
terminate silently after the reasoning phase without emitting any content
deltas. The official `grok-shell` client and 9router use the OpenAI
**Responses API** at `/v1/responses` with reasoning continuation via
`include: ["reasoning.encrypted_content"]`.

Reference parity: `decolua/9router` — `open-sse/executors/grok-cli.js`.

## Fix

Switched the Grok provider wire layer to the Responses API while keeping the
public proxy contract in OpenAI Chat Completions shape. Three pure translators
were added:

- `translateChatRequestToResponses` — Chat Completions request → Responses
  request (`messages` → `input`, `system` → `instructions`, tool_calls /
  tool_result ↔ function_call / function_call_output, allowlist filter strips
  `stream_options`/`service_tier`/`max_tokens`/`previous_response_id`, sets
  `store: false` and `reasoning: { summary: "concise", effort }` with
  `include: ["reasoning.encrypted_content"]` always on).
- `jsonResponsesToChatCompletion` — non-streaming Responses JSON → Chat
  Completions JSON (lifts `output[].message.content` / `function_call` /
  `reasoning.summary` into `choices[0].message`).
- `translateResponsesSseToChatSse` — streaming Responses SSE → Chat Completions
  SSE. Maps `response.output_text.delta` → `delta.content`,
  `response.reasoning_summary_text.delta` → `delta.reasoning_content`,
  `response.output_item.added` (function_call) → `delta.tool_calls`,
  `response.function_call_arguments.delta` → argument fragments,
  `response.completed` → final chunk with `finish_reason` + `usage`, and
  **always** emits a final chunk + `data: [DONE]` even when upstream closes
  early. This last guarantee is the core of the "thinks then dies" fix —
  the client now sees a properly terminated stream regardless of upstream
  behavior.

The translators sit in `src/proxy/providers/grok/responses.ts` and are used
from `wire.ts` in four places:

- `grokCliUpstreamChat` — endpoint `/responses`, body translated
- `grokCliChatCompletion` — non-stream response normalized via
  `jsonResponsesToChatCompletion`
- `grokCliChatCompletionStream` — upstream body piped through
  `translateResponsesSseToChatSse` before being returned
- `grokCliFetchQuota` — probe body translated to Responses shape

Downstream consumers (`wrapStreamWithUsageFinalizer` in `proxy/index.ts` and
`openAIStreamToAnthropic` in `proxy/transforms/anthropic.ts`) are unchanged —
they already consume standard Chat Completions SSE and treat
`delta.reasoning_content` as thinking deltas, so the output of the translator
is fully compatible.

## Rollback

Set `GROK_CLI_USE_RESPONSES_API=false` to revert to the legacy
`/chat/completions` wire path without a redeploy.

## Verification

- `bun test src/proxy/providers/grok/` — 76 pass, 0 fail
  (includes the regression test "thinking-only response (no output_text)
  still finishes cleanly")
- `bun run build` — TypeScript + Vite build clean
- The 9 unrelated pre-existing failures in `test/proxy/` (BYOK provider,
  logging, routing) were verified to fail identically on `main` HEAD before
  these changes.

## Files

- `src/proxy/providers/grok/responses.ts` (new) — translators
- `src/proxy/providers/grok/responses.test.ts` (new) — 27 unit tests
- `src/proxy/providers/grok/wire.ts` — endpoint + body + stream wiring
- `src/proxy/providers/grok/index.ts` — public re-exports
