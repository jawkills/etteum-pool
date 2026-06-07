import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Qoder CLI port — auth + chat (PAT/COSY flow, no browser cookie)
// Reverse-engineered from github.com/cubk1/qoder2api (Java) + qodercli bundle.
// ============================================================================

const COSY_VERSION = "0.1.43";
const APPCODE = "cosy";
const SIG_SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw=="; // base64("war, war never changes")
const JOB_TOKEN_URL = "https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1";
const USER_STATUS_URL = "https://center.qoder.sh/algo/api/v3/user/status?Encode=1";
const QOTA_USAGE_URL = "https://openapi.qoder.sh/api/v2/quota/usage";

export function openApiHeaders(securityOauthToken: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${securityOauthToken}`,
    "Cosy-ClientType": "5",
    "Cosy-Version": "1.0.6",
    "User-Agent": "qoder/1.0.6",
  };
}
const CHAT_URL =
  "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

// 1024-bit RSA pubkey extracted from qodercli bundle. Server uses this to decrypt
// the per-session AES key. Rotation by Qoder will break all clients at once.
const SERVER_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CUSTOM_PAD = "$";

const C2S = new Array(128).fill(-1);
const S2C = new Array(128).fill(-1);
for (let i = 0; i < 64; i++) {
  C2S[CUSTOM_ALPHABET.charCodeAt(i)] = STD_ALPHABET.charCodeAt(i);
  S2C[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
}
C2S[CUSTOM_PAD.charCodeAt(0)] = "=".charCodeAt(0);
S2C["=".charCodeAt(0)] = CUSTOM_PAD.charCodeAt(0);

export function encodeQoderPayload(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  const std = bytes.toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.substring(n - a) + std.substring(a, n - a) + std.substring(0, a);
  let out = "";
  for (let i = 0; i < n; i++) {
    const c = rearranged.charCodeAt(i);
    const m = c < 128 ? S2C[c] : -1;
    if (m < 0) throw new Error(`char out of alphabet: ${rearranged[i]}`);
    out += String.fromCharCode(m);
  }
  return out;
}

function rfc1123Date(d = new Date()): string {
  return d.toUTCString();
}

function md5Hex(s: string): string {
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}

function signSignatureHeader(date: string): string {
  return md5Hex(`${APPCODE}&${SIG_SECRET}&${date}`);
}

function rsaEncryptKey(tempKey: Buffer): Buffer {
  return crypto.publicEncrypt(
    { key: SERVER_PUBKEY_PEM, padding: crypto.constants.RSA_PKCS1_PADDING },
    tempKey,
  );
}

function aesEncryptCbc(plain: Buffer, key: Buffer): Buffer {
  // IV = key (matches Java BearerBuilder)
  const cipher = crypto.createCipheriv("aes-128-cbc", key, key);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

interface AuthIdentity {
  name: string;
  aid: string;
  uid: string;
  yx_uid: string;
  organization_id: string;
  organization_name: string;
  user_type: string;
  security_oauth_token: string;
  refresh_token: string;
}

interface SessionContext {
  cosyKey: string; // base64(RSA(tempKey))
  info: string;    // base64(AES(identityJson, tempKey))
}

function buildSessionContext(identity: AuthIdentity): SessionContext {
  const tempKey = Buffer.from(crypto.randomUUID().replace(/-/g, "").slice(0, 16), "ascii");
  const cosyKey = rsaEncryptKey(tempKey).toString("base64");
  const info = aesEncryptCbc(Buffer.from(JSON.stringify(identity), "utf8"), tempKey).toString("base64");
  return { cosyKey, info };
}

function buildPayloadB64(info: string): string {
  // Sorted keys (matches Java TreeMap)
  const m = {
    cosyVersion: COSY_VERSION,
    ideVersion: "",
    info,
    requestId: crypto.randomUUID(),
    version: "v1",
  };
  return Buffer.from(JSON.stringify(m), "utf8").toString("base64");
}

function signBearerRequest(payloadB64: string, cosyKey: string, cosyDate: string, body: string, pathSig: string): string {
  return md5Hex(`${payloadB64}\n${cosyKey}\n${cosyDate}\n${body}\n${pathSig}`);
}

function pathSigFromUrl(fullUrl: string): string {
  const u = new URL(fullUrl);
  return u.pathname.startsWith("/algo") ? u.pathname.slice("/algo".length) : u.pathname;
}

interface QoderTokens {
  personalToken: string;
  securityOauthToken?: string;
  refreshToken?: string;
  userId?: string;
  userName?: string;
  userType?: string;
  plan?: string;
  expireTime?: number;
  email?: string;
  machineId: string;
  machineToken: string;
  machineType: string;
}

function generateMachineIdentity() {
  const machineId = crypto.randomUUID();
  const machineToken = Buffer.from(
    (crypto.randomUUID() + crypto.randomUUID()).slice(0, 50),
    "ascii",
  ).toString("base64url");
  const machineType = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
  return { machineId, machineToken, machineType };
}

export function signatureHeaders(tokens: QoderTokens): Record<string, string> {
  const date = rfc1123Date();
  return {
    "cosy-machinetoken": tokens.machineToken,
    "cosy-machinetype": tokens.machineType,
    "login-version": "v2",
    appcode: APPCODE,
    accept: "application/json",
    "accept-encoding": "identity",
    "cosy-version": COSY_VERSION,
    "cosy-clienttype": "5",
    date,
    signature: signSignatureHeader(date),
    "content-type": "application/json",
    "cosy-machineid": tokens.machineId,
    "user-agent": "Go-http-client/2.0",
  };
}

interface JobTokenResponse {
  id?: string;
  name?: string;
  securityOauthToken?: string;
  refreshToken?: string;
  expireTime?: number;
  email?: string;
  plan?: string;
  userType?: string;
}

async function exchangeJobToken(tokens: QoderTokens): Promise<JobTokenResponse> {
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
    const text = await resp.text().catch(() => "");
    throw new Error(`jobToken HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  return (await resp.json()) as JobTokenResponse;
}

function buildIdentity(tokens: QoderTokens): AuthIdentity {
  return {
    name: tokens.userName || "",
    aid: tokens.userId || "",
    uid: tokens.userId || "",
    yx_uid: "",
    organization_id: "",
    organization_name: "",
    user_type: tokens.userType || "personal_standard",
    security_oauth_token: tokens.securityOauthToken || "",
    refresh_token: tokens.refreshToken || "",
  };
}

interface BearerCallOptions {
  url: string;
  body: unknown;
  extraHeaders?: Record<string, string>;
  stream?: boolean;
}

export async function bearerFetch(tokens: QoderTokens, opts: BearerCallOptions): Promise<Response> {
  const session = buildSessionContext(buildIdentity(tokens));
  const bodyEncoded = opts.body == null ? "" : encodeQoderPayload(JSON.stringify(opts.body));
  const payloadB64 = buildPayloadB64(session.info);
  const date = String(Math.floor(Date.now() / 1000));
  const pathSig = pathSigFromUrl(opts.url);
  const sig = signBearerRequest(payloadB64, session.cosyKey, date, bodyEncoded, pathSig);

  const headers: Record<string, string> = {
    "cosy-data-policy": "AGREE",
    "content-type": "application/json",
    "cosy-machinetype": tokens.machineType,
    "cosy-clienttype": "5",
    "cosy-date": date,
    "cosy-user": tokens.userId || "",
    "cosy-key": session.cosyKey,
    "cache-control": "no-cache",
    accept: opts.stream ? "text/event-stream" : "application/json",
    "cosy-clientip": "169.254.198.161",
    authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "accept-encoding": "identity",
    "cosy-version": COSY_VERSION,
    "cosy-machineid": tokens.machineId,
    "cosy-machinetoken": tokens.machineToken,
    "login-version": "v2",
    "user-agent": "Go-http-client/2.0",
    ...(opts.extraHeaders || {}),
  };

  return fetch(opts.url, {
    method: "POST",
    headers,
    body: bodyEncoded,
  });
}

// ============================================================================
// Provider implementation
// ============================================================================

interface QoderModelDef {
  id: string;           // proxy-facing ID (qd-*)
  upstream: string;     // server-side model key
  display_name: string;
  max_input_tokens: number;
  is_vl: boolean;
  is_reasoning: boolean;
  price_factor: number;
}

const QODER_MODELS: QoderModelDef[] = [
  { id: "qd-Auto",              upstream: "auto",          display_name: "Auto",              max_input_tokens: 180000, is_vl: true,  is_reasoning: false, price_factor: 1 },
  { id: "qd-Ultimate",          upstream: "ultimate",      display_name: "Ultimate",          max_input_tokens: 180000, is_vl: true,  is_reasoning: true,  price_factor: 1.6 },
  { id: "qd-Performance",       upstream: "performance",   display_name: "Performance",       max_input_tokens: 272000, is_vl: true,  is_reasoning: false, price_factor: 1.1 },
  { id: "qd-Efficient",         upstream: "efficient",     display_name: "Efficient",         max_input_tokens: 180000, is_vl: true,  is_reasoning: false, price_factor: 0.3 },
  { id: "qd-Lite",              upstream: "lite",          display_name: "Lite",              max_input_tokens: 180000, is_vl: false, is_reasoning: false, price_factor: 0 },
  { id: "qd-Qwen3.7-Max",       upstream: "qmodel_latest", display_name: "Qwen3.7-Max",       max_input_tokens: 180000, is_vl: true,  is_reasoning: false, price_factor: 0.2 },
  { id: "qd-Qwen3.6-Plus",      upstream: "qmodel",        display_name: "Qwen3.6-Plus",      max_input_tokens: 180000, is_vl: true,  is_reasoning: false, price_factor: 0.2 },
  { id: "qd-DeepSeek-V4-Pro",   upstream: "dmodel",        display_name: "DeepSeek-V4-Pro",   max_input_tokens: 180000, is_vl: true,  is_reasoning: true,  price_factor: 0.5 },
  { id: "qd-DeepSeek-V4-Flash", upstream: "dfmodel",       display_name: "DeepSeek-V4-Flash", max_input_tokens: 180000, is_vl: true,  is_reasoning: true,  price_factor: 0.1 },
  { id: "qd-GLM-5.1",           upstream: "gm51model",     display_name: "GLM-5.1",           max_input_tokens: 180000, is_vl: true,  is_reasoning: true,  price_factor: 0.6 },
  { id: "qd-Kimi-K2.6",         upstream: "kmodel",        display_name: "Kimi-K2.6",         max_input_tokens: 256000, is_vl: true,  is_reasoning: false, price_factor: 0.3 },
  { id: "qd-MiniMax-M2.7",      upstream: "mmodel",        display_name: "MiniMax-M2.7",      max_input_tokens: 180000, is_vl: true,  is_reasoning: false, price_factor: 0.2 },
];

const MODEL_CONFIGS: Record<string, QoderModelDef> = Object.fromEntries(
  QODER_MODELS.map((m) => [m.id, m]),
);

let CACHED_TEMPLATE: any = null;
function loadTemplate(): any {
  if (CACHED_TEMPLATE) return CACHED_TEMPLATE;
  try {
    const filePath = path.join(__dirname, "qoder-baseprompt.json");
    let raw = fs.readFileSync(filePath, "utf8");
    raw = raw.replace(/\{UUID[1-5]\}/g, () => crypto.randomUUID());
    raw = raw.replace(/\{TIME1\}/g, String(Date.now()));
    CACHED_TEMPLATE = JSON.parse(raw);
  } catch (e) {
    CACHED_TEMPLATE = null;
  }
  return CACHED_TEMPLATE;
}

function extractLatestUserPrompt(request: ChatCompletionRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const msg = request.messages[i];
    if (!msg || msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const text = (msg.content as any[]).find((b) => b?.type === "text")?.text;
      if (typeof text === "string" && text) return text;
    }
  }
  return "";
}

function extractLatestUserImages(request: ChatCompletionRequest): any[] {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const msg = request.messages[i];
    if (!msg || msg.role !== "user") continue;
    if (!Array.isArray(msg.content)) continue;
    const images: any[] = [];
    for (const b of msg.content as any[]) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "image_url" || b.type === "image") {
        images.push(normalizeImageBlock(b));
      }
    }
    if (images.length > 0) return images;
  }
  return [];
}

function normalizeImageBlock(block: any): any {
  // OpenAI format: { type: "image_url", image_url: { url: "..." } }
  if (block.type === "image_url" && block.image_url?.url) {
    return block; // already in OpenAI format
  }
  // Anthropic format: { type: "image", source: { type: "base64", media_type: "...", data: "..." } }
  if (block.type === "image" && block.source?.type === "base64") {
    const { media_type, data } = block.source;
    return {
      type: "image_url",
      image_url: {
        url: `data:${media_type};base64,${data}`,
      },
    };
  }
  // Fallback: return as-is
  return block;
}

function buildQoderMessages(request: ChatCompletionRequest, templateMessages: any[] | undefined, hasIncomingTools: boolean): any[] {
  const incomingHasSystem = request.messages.some((m) => m.role === "system");
  const result: any[] = [];

  if (hasIncomingTools && !incomingHasSystem) {
    // Build detailed tool descriptions with schemas for better guidance
    const toolDescriptions = (request.tools || [])
      .map((t: any) => {
        const name = t?.function?.name || t?.name;
        const desc = t?.function?.description || t?.description || "No description";
        const params = t?.function?.parameters?.properties || t?.parameters?.properties || {};
        const paramNames = Object.keys(params);
        const paramInfo = paramNames.length > 0
          ? ` Parameters: ${paramNames.join(", ")}`
          : "";
        return `- ${name}: ${desc}${paramInfo}`;
      })
      .filter(Boolean)
      .join("\n");

    const toolNames = (request.tools || [])
      .map((t: any) => t?.function?.name || t?.name)
      .filter(Boolean)
      .join(", ");

    result.push({
      role: "system",
      content: `You are a helpful assistant with access to the following tools:

${toolDescriptions}

## Tool Usage Guidelines:

1. **When to use tools**: When the user's request requires information retrieval, file operations, code execution, or any action that these tools can perform, you MUST call the appropriate tool. Do not say you cannot help; instead, invoke the tool with the correct arguments.

2. **Trust tool results**: After calling a tool, you will receive the tool result in the conversation. The tool result contains the actual data or outcome of the tool execution. Use this information to formulate your response. Do not claim you didn't receive file contents or data if the tool result was provided.

3. **Multi-turn workflows**: For complex tasks requiring multiple tool calls:
   - Call tools sequentially as needed
   - Use information from previous tool results to inform subsequent calls
   - Only respond with your final answer after you have gathered all necessary information

4. **Error handling**: If a tool returns an error or empty result, acknowledge this to the user and suggest alternatives or next steps.

5. **Text-only responses**: Only respond with plain text (without tool calls) when:
   - No available tool can address the user's request
   - You already have all the information needed from previous tool results
   - The user is asking for clarification or a simple answer

Available tools: ${toolNames}`,
    });
  } else if (!hasIncomingTools && !incomingHasSystem && Array.isArray(templateMessages)) {
    for (const m of templateMessages) {
      if (m && m.role === "system") result.push(m);
    }
  }

  for (const m of request.messages) {
    // Handle assistant messages with tool_calls (OpenAI format)
    if (m.role === "assistant" && (m as any).tool_calls) {
      const toolCalls = (m as any).tool_calls.map((tc: any) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.function?.name || "",
          arguments: typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments || {}),
        },
      }));

      const content = typeof m.content === "string" ? m.content : "";
      result.push({
        role: "assistant",
        content,
        contents: content ? [{ type: "text", text: content }] : [],
        tool_calls: toolCalls,
      });
      continue;
    }

    if (typeof m.content === "string") {
      const msg: any = { role: m.role, content: m.content, contents: [{ type: "text", text: m.content }] };
      // Preserve tool_call_id for OpenAI tool messages
      if (m.role === "tool" && (m as any).tool_call_id) {
        msg.tool_call_id = (m as any).tool_call_id;
      }
      result.push(msg);
      continue;
    }
    if (Array.isArray(m.content)) {
      const blocks = m.content as any[];
      const textParts: string[] = [];
      const imageParts: any[] = [];
      const toolCalls: any[] = [];
      const toolResults: { tool_call_id: string; content: string }[] = [];

      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && typeof b.text === "string") {
          textParts.push(b.text);
        } else if (b.type === "image_url" || b.type === "image") {
          imageParts.push(normalizeImageBlock(b));
        } else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: {
              name: b.name,
              arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input || {}),
            },
          });
        } else if (b.type === "tool_result") {
          let content = "";
          if (typeof b.content === "string") {
            content = b.content;
          } else if (Array.isArray(b.content)) {
            content = (b.content as any[])
              .map((inner) => (inner?.type === "text" && typeof inner.text === "string" ? inner.text : ""))
              .filter(Boolean)
              .join("\n");
          }
          if (b.is_error) content = `[ERROR] ${content}`;
          toolResults.push({ tool_call_id: b.tool_use_id, content });
        }
      }

      const textContent = textParts.join("\n");

      // Build contents array (Qoder native format) — text + images
      const contentsArr: any[] = [];
      if (textContent) contentsArr.push({ type: "text", text: textContent });
      contentsArr.push(...imageParts);

      if (m.role === "assistant" && toolCalls.length > 0) {
        const msg: any = { role: "assistant", content: textContent, contents: [{ type: "text", text: textContent }] };
        msg.tool_calls = toolCalls;
        result.push(msg);
        continue;
      }

      if (m.role === "user" && toolResults.length > 0) {
        for (const tr of toolResults) {
          result.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
        }
        if (contentsArr.length > 0) {
          result.push({ role: "user", content: textContent, contents: contentsArr });
        }
        continue;
      }

      result.push({ role: m.role, content: textContent, contents: contentsArr });
      continue;
    }
    result.push({ role: m.role, content: "", contents: [] });
  }

  return result;
}

function buildChatBody(request: ChatCompletionRequest, tokens: QoderTokens): any {
  const prompt = extractLatestUserPrompt(request);
  const images = extractLatestUserImages(request);
  const cfg = MODEL_CONFIGS[request.model] || QODER_MODELS[0]!;
  const reqId = crypto.randomUUID();
  const hasIncomingTools = Array.isArray(request.tools) && request.tools.length > 0;

  const template = loadTemplate();
  const body: any = template ? JSON.parse(JSON.stringify(template)) : {};

  body.request_id = reqId;
  body.chat_record_id = reqId;
  body.request_set_id = crypto.randomUUID();
  body.session_id = crypto.randomUUID();
  body.stream = true;
  body.aliyun_user_type = tokens.userType || "personal_standard";

  if (!body.model_config) body.model_config = {};
  body.model_config.key = cfg.upstream;
  body.model_config.display_name = cfg.display_name;
  body.model_config.is_vl = cfg.is_vl;
  body.model_config.is_reasoning = cfg.is_reasoning;
  body.model_config.max_input_tokens = cfg.max_input_tokens;
  body.model_config.format = body.model_config.format || "openai";
  body.model_config.source = body.model_config.source || "system";

  if (!body.business) body.business = {};
  body.business.id = crypto.randomUUID();
  body.business.begin_at = Date.now();
  body.business.name = prompt.slice(0, 30);

  if (!body.chat_context) body.chat_context = {};
  body.chat_context.text = { type: "text", text: prompt };
  if (images.length > 0) {
    body.chat_context.images = images;
    // Also set imageUrls at chat_context level (some Qoder endpoints check this)
    body.chat_context.imageUrls = images.map((img: any) => img.image_url?.url).filter(Boolean);
  }
  if (!body.chat_context.extra) body.chat_context.extra = {};
  body.chat_context.extra.originalContent = { type: "text", text: prompt };
  if (images.length > 0) {
    body.chat_context.extra.images = images;
  }
  if (!body.chat_context.extra.modelConfig) body.chat_context.extra.modelConfig = {};
  body.chat_context.extra.modelConfig.key = cfg.upstream;
  body.chat_context.extra.modelConfig.is_reasoning = cfg.is_reasoning;

  // Set top-level image_urls (Qoder API also checks this field)
  if (images.length > 0) {
    body.image_urls = images.map((img: any) => img.image_url?.url).filter(Boolean);
  }

  body.messages = buildQoderMessages(request, body.messages, hasIncomingTools);

  if (request.max_tokens && body.parameters) {
    body.parameters.max_tokens = request.max_tokens;
  }

  if (hasIncomingTools) {
    body.tools = request.tools;
  }

  return body;
}

/**
 * Generate OpenAI-style tool call ID.
 * OpenAI uses format: "call_" + 24 alphanumeric characters
 */
function generateOpenAIToolId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'call_';
  for (let i = 0; i < 24; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Normalize tool call ID to OpenAI format.
 * OpenAI uses simple alphanumeric IDs like "call_abc123...", not Anthropic's "toolu_*" format.
 * If the upstream ID is too short, generate a new one.
 */
function normalizeToolCallId(id: string | undefined, index: number): string {
  if (!id) {
    // Generate OpenAI-style ID if none provided
    return generateOpenAIToolId();
  }
  // Strip Anthropic prefix if present (for compatibility)
  if (id.startsWith("toolu_")) {
    id = id.slice(6);
  }
  // If ID is too short (< 20 chars after stripping), generate a new one
  if (id.length < 20) {
    return generateOpenAIToolId();
  }
  return id;
}

interface ToolCallAcc {
  index: number;
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ParsedDelta {
  role?: string;
  content?: string;
  reasoningContent?: string;
  toolCalls?: any[];
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function parseSseLine(line: string): ParsedDelta | null {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try {
    const wrapper = JSON.parse(data);
    const innerStr = wrapper.body;
    if (typeof innerStr !== "string" || !innerStr) return null;
    if (innerStr === "[DONE]") return null;
    const inner = JSON.parse(innerStr);
    const result: ParsedDelta = {};

    if (inner.usage) {
      result.usage = {
        prompt_tokens: Number(inner.usage.prompt_tokens) || 0,
        completion_tokens: Number(inner.usage.completion_tokens) || 0,
        total_tokens: Number(inner.usage.total_tokens) || 0,
      };
    }

    const choice = inner.choices?.[0];
    if (!choice) {
      return result.usage ? result : null;
    }
    const delta = choice.delta || {};
    if (choice.finish_reason) result.finishReason = choice.finish_reason;
    if (typeof delta.role === "string") result.role = delta.role;
    if (typeof delta.content === "string") result.content = delta.content;
    if (typeof delta.reasoning_content === "string") result.reasoningContent = delta.reasoning_content;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      result.toolCalls = delta.tool_calls;
    }
    return result;
  } catch {
    return null;
  }
}

export class QoderProvider extends BaseProvider {
  name = "qoder";

  override ownsModel(model: string): boolean {
    return model.toLowerCase().startsWith("qd-");
  }

  supportedModels: ModelInfo[] = QODER_MODELS.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: Date.now(),
    owned_by: "qoder",
    context_window: m.max_input_tokens,
    max_output: 64000,
    thinking: m.is_reasoning,
    vision: m.is_vl,
    creditUnit: "credit" as const,
    creditRate: (0.004 * Math.max(0.001, m.price_factor)) / 1000,
    creditSource: "estimated" as const,
  }));

  private parseTokens(account: Account): QoderTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
      if (!t || typeof t !== "object" || !t.personalToken) return null;
      return t as QoderTokens;
    } catch {
      return null;
    }
  }

  private async ensureFreshAuth(tokens: QoderTokens): Promise<{ tokens: QoderTokens; refreshed: boolean }> {
    const now = Date.now();
    const needsRefresh =
      !tokens.securityOauthToken ||
      !tokens.userId ||
      (tokens.expireTime && tokens.expireTime - 60_000 < now);

    if (!needsRefresh) return { tokens, refreshed: false };

    const jt = await exchangeJobToken(tokens);
    if (!jt.id) {
      throw new Error("jobToken response missing user id");
    }

    const updated: QoderTokens = {
      ...tokens,
      userId: jt.id,
      userName: jt.name || tokens.userName || "",
      securityOauthToken: jt.securityOauthToken || tokens.securityOauthToken || "",
      refreshToken: jt.refreshToken || tokens.refreshToken || "",
      userType: jt.userType || tokens.userType || "personal_standard",
      plan: jt.plan || tokens.plan,
      expireTime: jt.expireTime || tokens.expireTime,
      email: jt.email || tokens.email,
    };
    return { tokens: updated, refreshed: true };
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const result = await this.chatCompletionStream(account, request);
    if (!result.success || !result.stream) return result;

    const reader = result.stream.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    const toolCalls: ToolCallAcc[] = [];
    let finishReason: string | null = null;
    let finalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          if (line === "data: [DONE]") continue;
          try {
            const chunk = JSON.parse(line.slice(6));
            // Extract usage from final chunk (has empty choices array)
            if (chunk.usage && chunk.usage.total_tokens > 0) {
              finalUsage = {
                prompt_tokens: Number(chunk.usage.prompt_tokens) || 0,
                completion_tokens: Number(chunk.usage.completion_tokens) || 0,
                total_tokens: Number(chunk.usage.total_tokens) || 0,
              };
            }
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) fullContent += delta.content;
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? toolCalls.length;
                if (!toolCalls[idx]) {
                  toolCalls[idx] = { index: idx, id: tc.id || "", type: "function", function: { name: "", arguments: "" } };
                }
                if (tc.id) toolCalls[idx].id = tc.id;
                if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
            if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
          } catch {}
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Fall back to estimation if upstream didn't report usage
    if (finalUsage.total_tokens === 0) {
      const estimated = this.estimateMessagesTokens(request.messages);
      finalUsage = { prompt_tokens: estimated, completion_tokens: this.estimateTokens(fullContent), total_tokens: estimated + this.estimateTokens(fullContent) };
    }

    const filledToolCalls = toolCalls.filter((t) => t && t.id);
    const response: ChatCompletionResponse = {
      id: this.generateId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: fullContent || "",
          ...(filledToolCalls.length > 0 ? { tool_calls: filledToolCalls } : {}),
        },
        finish_reason: finishReason || (filledToolCalls.length > 0 ? "tool_calls" : "stop"),
      }],
      usage: finalUsage,
    };

    return {
      ...result,
      success: true,
      response,
      stream: undefined,
      tokensUsed: finalUsage.total_tokens,
      promptTokens: finalUsage.prompt_tokens,
      completionTokens: finalUsage.completion_tokens,
    };
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const parsed = this.parseTokens(account);
    if (!parsed?.personalToken) {
      return { success: false, error: "No personalToken available" };
    }

    let tokens: QoderTokens;
    let refreshed = false;
    try {
      const auth = await this.ensureFreshAuth(parsed);
      tokens = auth.tokens;
      refreshed = auth.refreshed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: `expired: ${msg}` };
    }

    const body = buildChatBody(request, tokens);
    let resp: Response;
    try {
      resp = await bearerFetch(tokens, { url: CHAT_URL, body, stream: true });
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }

    if (resp.status === 401 || resp.status === 403) {
      return { success: false, error: `expired: HTTP ${resp.status}` };
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { success: false, error: `Qoder chat HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    if (!resp.body) {
      return { success: false, error: "Qoder response missing body" };
    }

    const upstream = resp.body;
    const id = this.generateId();
    const model = request.model;
    const encoder = new TextEncoder();

    // Track usage across the stream — will be emitted in final chunk
    let accumulatedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const reader = upstream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let sentRole = false;
        let finishEmitted = false;
        const toolIndex = new Map<string, number>();
        let nextToolIdx = 0;
        const pendingToolCalls = new Map<number, { id: string; function: { name: string; arguments: string } }>();
        let lastActivity = Date.now();
        const STREAM_TIMEOUT = 300000; // 5 minutes
        let streamActive = true;

        const enqueue = (delta: any, finishReason: string | null = null, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => {
          if (!streamActive) {
            return; // Skip enqueue if stream is already closed
          }
          try {
            const chunk: any = {
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta, finish_reason: finishReason }],
            };
            // Include usage in the finish chunk per OpenAI spec
            if (usage) {
              chunk.usage = usage;
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          } catch (e) {
            // Controller closed or error - mark stream as inactive
            streamActive = false;
            console.log(`[Qoder] Stream enqueue failed (client likely disconnected): ${e instanceof Error ? e.message : String(e)}`);
          }
        };

        try {
          while (streamActive) {
            // Check timeout
            if (Date.now() - lastActivity > STREAM_TIMEOUT) {
              console.error(`[Qoder] Stream timeout after ${STREAM_TIMEOUT}ms`);
              break;
            }

            // Use Promise.race for timeout on read
            const readPromise = reader.read();
            const timeoutPromise = new Promise<{ done: boolean; value?: Uint8Array }>((_, reject) => {
              setTimeout(() => reject(new Error("Stream read timeout")), STREAM_TIMEOUT);
            });

            let result;
            try {
              result = await Promise.race([readPromise, timeoutPromise]);
            } catch (e) {
              console.error(`[Qoder] Stream read error: ${e instanceof Error ? e.message : String(e)}`);
              break;
            }

            if (result.done) break;
            lastActivity = Date.now();

            buffer += decoder.decode(result.value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const raw of lines) {
              const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
              if (!line) continue;

              // Detect Qoder error responses in SSE body (HTTP 200 but error in JSON)
              // Format: {"code":"112","statusCodeValue":403,"message":"..."}
              if (line.startsWith("data:")) {
                const dataStr = line.slice(5).trim();
                if (dataStr && dataStr !== "[DONE]") {
                  try {
                    const wrapper = JSON.parse(dataStr);
                    const svc = wrapper.statusCodeValue;
                    if (svc && svc >= 400) {
                      const errStatus = wrapper.statusCode || "";
                      let errMsg = wrapper.message || "";
                      if (typeof errMsg === "string" && errMsg.startsWith("{")) {
                        try { const p = JSON.parse(errMsg); errMsg = p.pricingUrl || JSON.stringify(p); } catch {}
                      }
                      const fullErr = `Qoder HTTP ${svc} ${errStatus}: ${errMsg.slice(0, 200) || "rate limited or quota exceeded"}`;
                      console.error(`[Qoder] ${fullErr}`);
                      // Emit error to client and stop stream
                      try {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: fullErr, type: "upstream_error" } })}\n\n`));
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                      } catch {}
                      streamActive = false;
                      finishEmitted = true;
                      break;
                    }
                  } catch {}
                }
              }

              const parsedDelta = parseSseLine(line);
              if (!parsedDelta) continue;

              // Track usage from upstream (usually in final chunk)
              if (parsedDelta.usage) {
                accumulatedUsage = parsedDelta.usage;
              }

              // Build delta object, combining role with first content (OpenAI spec)
              const delta: any = {};

              if (!sentRole) {
                // Include role in the first chunk that has any content
                if (parsedDelta.reasoningContent || parsedDelta.content || parsedDelta.toolCalls) {
                  delta.role = "assistant";
                  sentRole = true;
                }
              }

              if (parsedDelta.reasoningContent) {
                delta.reasoning_content = parsedDelta.reasoningContent;
              }

              if (parsedDelta.content) {
                delta.content = parsedDelta.content;
              }

              if (parsedDelta.toolCalls) {
                const remapped: any[] = [];
                for (const tc of parsedDelta.toolCalls) {
                  const key = typeof tc.index === "number" ? `idx-${tc.index}` : (tc.id || `tool-${nextToolIdx}`);
                  let idx = toolIndex.get(key);
                  if (idx === undefined) {
                    idx = nextToolIdx++;
                    toolIndex.set(key, idx);
                    pendingToolCalls.set(idx, { id: "", function: { name: "", arguments: "" } });
                    // Generate stable ID once per tool call (not per chunk)
                    const stableId = normalizeToolCallId(tc.id, idx);
                    pendingToolCalls.get(idx)!.id = stableId;
                  }
                  // Use stable ID from pendingToolCalls (consistent across chunks)
                  const stableId = pendingToolCalls.get(idx)!.id;
                  if (tc.function?.name) pendingToolCalls.get(idx)!.function.name = tc.function.name;
                  if (tc.function?.arguments) pendingToolCalls.get(idx)!.function.arguments += tc.function.arguments;
                  remapped.push({
                    index: idx,
                    id: stableId,
                    ...(tc.type ? { type: tc.type } : { type: "function" }),
                    ...(tc.function ? { function: tc.function } : {}),
                  });
                }
                delta.tool_calls = remapped;
              }

              // Only enqueue if delta has content (not empty)
              if (Object.keys(delta).length > 0) {
                enqueue(delta);
              }

              if (parsedDelta.finishReason) {
                // Include usage in the finish chunk (OpenAI spec)
                enqueue({}, parsedDelta.finishReason, accumulatedUsage.total_tokens > 0 ? accumulatedUsage : undefined);
                finishEmitted = true;
              }
            }
          }

          if (!finishEmitted && streamActive) {
            // Include usage in the final stop chunk per OpenAI spec
            enqueue({}, "stop", accumulatedUsage.total_tokens > 0 ? accumulatedUsage : undefined);
          }

          if (streamActive) {
            try {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } catch (e) {
              streamActive = false;
            }
          }
        } catch (error) {
          streamActive = false;
          const msg = error instanceof Error ? error.message : String(error);
          // Don't log client disconnects as errors
          if (msg.includes("cancelled") || msg.includes("aborted") || msg.includes("closed")) {
            console.log(`[Qoder] Stream ${msg}`);
          } else {
            console.error(`[Qoder] Stream error: ${msg}`);
          }
          // Try to send error to client (if stream still open)
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: msg, type: "api_error" } })}\n\n`));
          } catch {
            // Controller already closed, ignore
          }
        } finally {
          streamActive = false;
          try { controller.close(); } catch {}
          try { reader.releaseLock(); } catch {}
        }
      },
    });

    return {
      success: true,
      stream,
      tokensUsed: accumulatedUsage.total_tokens,
      promptTokens: accumulatedUsage.prompt_tokens,
      completionTokens: accumulatedUsage.completion_tokens,
      ...(refreshed ? { tokens: JSON.stringify(tokens) } : {}),
    };
  }

  async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const parsed = this.parseTokens(account);
    if (!parsed?.personalToken) return { success: false, error: "No personalToken" };
    try {
      const { tokens } = await this.ensureFreshAuth({ ...parsed, securityOauthToken: "", userId: "" });
      return { success: true, tokens: JSON.stringify(tokens) };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async validateAccount(account: Account): Promise<boolean> {
    const t = this.parseTokens(account);
    return !!t?.personalToken;
  }

  async fetchQuota(account: Account): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    const parsed = this.parseTokens(account);
    if (!parsed?.personalToken) return { success: false, error: "No personalToken" };

    try {
      const { tokens } = await this.ensureFreshAuth(parsed);
      if (!tokens.securityOauthToken) {
        return { success: false, error: "No securityOauthToken after refresh" };
      }

      const resp = await fetch(QOTA_USAGE_URL, {
        method: "GET",
        headers: openApiHeaders(tokens.securityOauthToken),
      });

      if (resp.status === 401 || resp.status === 403) {
        return { success: false, error: `Qoder quota rejected (${resp.status})` };
      }
      if (!resp.ok) {
        return { success: false, error: `Qoder quota HTTP ${resp.status}` };
      }

      const data = (await resp.json()) as {
        userQuota?: { total?: number; used?: number; remaining?: number };
        expiresAt?: number;
        isQuotaExceeded?: boolean;
      };

      const limit = Number(data.userQuota?.total) || 0;
      const used = Number(data.userQuota?.used) || 0;
      const remaining = Number(data.userQuota?.remaining ?? Math.max(0, limit - used));
      const resetAt = data.expiresAt ? new Date(data.expiresAt) : null;

      return { success: true, quota: { limit, remaining, used, resetAt } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const parsed = this.parseTokens(account);
    if (!parsed?.personalToken) {
      return { kind: "missing_tokens", success: false, error: "No personalToken" };
    }

    try {
      const { tokens, refreshed } = await this.ensureFreshAuth(parsed);
      if (!tokens.securityOauthToken) {
        return { kind: "session_expired", success: false, error: "No securityOauthToken after refresh" };
      }

      const resp = await fetch(QOTA_USAGE_URL, {
        method: "GET",
        headers: openApiHeaders(tokens.securityOauthToken),
      });

      if (resp.status === 401 || resp.status === 403) {
        return { kind: "session_expired", success: false, error: `Qoder rejected (${resp.status})` };
      }
      if (!resp.ok) {
        return { kind: "transient_error", success: false, retryable: true, error: `Qoder HTTP ${resp.status}` };
      }

      const data = (await resp.json()) as {
        userQuota?: { total?: number; used?: number; remaining?: number };
        expiresAt?: number;
        isQuotaExceeded?: boolean;
      };

      const limit = Number(data.userQuota?.total) || 0;
      const used = Number(data.userQuota?.used) || 0;
      const remaining = Number(data.userQuota?.remaining ?? Math.max(0, limit - used));
      const resetAt = data.expiresAt ? new Date(data.expiresAt) : undefined;

      // 0/0 quota (limit=0, remaining=0) means the API doesn't report meaningful
      // quota data — not that the account is truly exhausted. Only treat as
      // exhausted if the API explicitly flags it OR remaining went negative OR
      // there's a real quota (limit>0) that hit zero.
      const exceeded = data.isQuotaExceeded === true || (remaining < 0) || (remaining <= 0 && limit > 0);
      const quota = { limit, remaining, used, resetAt, source: "qoder.openapi" };

      return {
        kind: exceeded ? "exhausted" : "healthy",
        success: true,
        quota,
        ...(refreshed ? { tokens } : {}),
      };
    } catch (error) {
      return {
        kind: "transient_error",
        success: false,
        retryable: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================================================
// Public helpers (used by accounts API for add-account flow)
// ============================================================================

export async function activateQoderPat(personalToken: string): Promise<{ tokens: QoderTokens; jobToken: JobTokenResponse }> {
  const machine = generateMachineIdentity();
  const seed: QoderTokens = {
    personalToken,
    machineId: machine.machineId,
    machineToken: machine.machineToken,
    machineType: machine.machineType,
  };
  const jt = await exchangeJobToken(seed);
  if (!jt.id) throw new Error("Qoder jobToken response missing id");
  const tokens: QoderTokens = {
    ...seed,
    userId: jt.id,
    userName: jt.name || "",
    securityOauthToken: jt.securityOauthToken || "",
    refreshToken: jt.refreshToken || "",
    userType: jt.userType || "personal_standard",
    plan: jt.plan,
    expireTime: jt.expireTime,
    email: jt.email,
  };
  return { tokens, jobToken: jt };
}
