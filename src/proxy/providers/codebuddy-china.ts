import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
  type StreamChunk,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";
import {
  applyCodeBuddyUserIdHeader,
  classifyCodeBuddyHttpFailure,
  parseCodeBuddyResourceQuota,
} from "./codebuddy-auth";

interface CodeBuddyChinaTokens {
  api_key?: string;
  access_token?: string;
  session_token?: string;
}

/** Map cbc- prefixed model IDs to actual CodeBuddy China API model names. */
const CBC_MODEL_MAP: Record<string, string> = {
  // Claude
  "cbc-haiku-4.5": "claude-haiku-4.5",
  // DeepSeek
  "cbc-deepseek-r1": "deepseek-r1",
  "cbc-deepseek-v3": "deepseek-v3",
  "cbc-deepseek-v3-2-volc": "deepseek-v3-2-volc",
  "cbc-deepseek-v4-flash": "deepseek-v4-flash",
  "cbc-deepseek-v4-pro": "deepseek-v4-pro",
  // Kimi (Moonshot)
  "cbc-kimi-k2.5": "kimi-k2.5",
  "cbc-kimi-k2.6": "kimi-k2.6",
  "cbc-kimi-k2.7": "kimi-k2.7",
  // GLM (Zhipu)
  "cbc-glm-5.1": "glm-5.1",
  "cbc-glm-5.2": "glm-5.2",
  "cbc-glm-5v-turbo": "glm-5v-turbo",
  // MiniMax
  "cbc-minimax-m3": "minimax-m3",
  // Hunyuan (Tencent)
  "cbc-hy3-preview": "hy3-preview",
};

/**
 * CodeBuddy China Provider — codebuddy.cn region
 *
 * Same API format as CodeBuddy global (codebuddy.ai) but:
 * - Base URL: https://www.codebuddy.cn
 * - Auth: Bearer API key (ck_* prefix)
 * - Streaming only (non-stream returns error 11101)
 * - China-specific models (GLM, Kimi, DeepSeek V4, Hunyuan, MiniMax)
 * - Credit tracking via usage.credit in stream chunks
 */
export class CodeBuddyChinaProvider extends BaseProvider {
  name = "codebuddy-china";

  override ownsModel(model: string): boolean {
    return model.toLowerCase().startsWith("cbc-");
  }

  private resolveModel(model: string): string {
    const base = model.toLowerCase();
    return CBC_MODEL_MAP[base] || base;
  }

  private baseUrl = "https://www.codebuddy.cn";

  supportedModels: ModelInfo[] = [
    // Claude
    { id: "cbc-haiku-4.5", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 200000, max_output: 8192, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.11, creditSource: "upstream" },
    // DeepSeek — r1 / v3 are text-only; v3-2-volc / v4-flash / v4-pro support vision
    { id: "cbc-deepseek-r1", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 64000, max_output: 8192, thinking: true, vision: false, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
    { id: "cbc-deepseek-v3", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 64000, max_output: 8192, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
    { id: "cbc-deepseek-v3-2-volc", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 64000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
    { id: "cbc-deepseek-v4-flash", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 1000000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
    { id: "cbc-deepseek-v4-pro", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 1000000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.03, creditSource: "upstream" },
    // Kimi — k2.5 / k2.6 support vision; k2.7 is flaky (sometimes works with all-fields format)
    { id: "cbc-kimi-k2.5", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 164000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.05, creditSource: "upstream" },
    { id: "cbc-kimi-k2.6", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 256000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.09, creditSource: "upstream" },
    { id: "cbc-kimi-k2.7", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 256000, max_output: 8192, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.07, creditSource: "upstream" },
    // GLM — 5.1 / 5.2 / 5v-turbo all support vision (5v-turbo is the dedicated vision model)
    { id: "cbc-glm-5.1", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 200000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.02, creditSource: "upstream" },
    { id: "cbc-glm-5.2", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 1000000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.02, creditSource: "upstream" },
    { id: "cbc-glm-5v-turbo", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 200000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.03, creditSource: "upstream" },
    // MiniMax — vision support is flaky upstream (model often replies "I don't see"), kept enabled for parity
    { id: "cbc-minimax-m3", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 512000, max_output: 8192, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.10, creditSource: "upstream" },
    // Hunyuan — model itself always replies "I can't see the image" even with payload accepted; vision disabled
    { id: "cbc-hy3-preview", object: "model", created: Date.now(), owned_by: "codebuddy-china", context_window: 192000, max_output: 8192, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.01, creditSource: "upstream" },
  ];

  /** Cache for resolved tool schemas — the assistant sends the same tools every request */
  private schemaCache = new Map<string, any>();
  private static readonly SCHEMA_CACHE_MAX = 200;

  private getTokens(account: Account): CodeBuddyChinaTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string"
        ? JSON.parse(account.tokens)
        : account.tokens;
      return t as CodeBuddyChinaTokens;
    } catch {
      return null;
    }
  }

  private getApiKey(tokens: CodeBuddyChinaTokens): string | null {
    return tokens.api_key || tokens.access_token || tokens.session_token || null;
  }

  private buildHeaders(apiKey: string, stream = false): Record<string, string> {
    const headers: Record<string, string> = {
      "Accept": stream ? "text/event-stream, application/json, */*" : "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-Conversation-ID": crypto.randomUUID(),
      "X-Request-ID": crypto.randomUUID().replace(/-/g, ""),
      "X-Domain": "www.codebuddy.cn",
      "X-Product": "SaaS",
      "Authorization": `Bearer ${apiKey}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };
    applyCodeBuddyUserIdHeader(headers, apiKey);
    return headers;
  }

  /**
   * Clean messages: convert Anthropic-format content blocks (tool_use, tool_result)
   * to OpenAI-format (tool_calls, tool messages). Also handle agent system prompt
   * detection and replacement.
   *
   * CodeBuddy China vision: images in content blocks are extracted and sent as
  /**
   * Convert request messages from Anthropic format to OpenAI format compatible with
   * CodeBuddy China's `/v2/chat/completions` upstream.
   *
   * Vision images use the STANDARD OpenAI format: `image_url` blocks INSIDE the
   * `content` array (NOT hoisted to top-level fields). This was confirmed by
   * reverse-engineering zxyblzcat/uniview-codebuddy-proxy and verified by direct
   * upstream testing — models glm-4.6v, glm-5v-turbo, and deepseek-v3-2-volc
   * return accurate, non-hallucinated descriptions with this format.
   *
   * The PREVIOUS approach (top-level `files` + `image_url` + `images` + `vision: true`
   * flag with text-flattened content) produced 100% hallucinated/blind responses
   * because the upstream silently dropped the image data — see commit history.
   */
  private cleanMessages(request: ChatCompletionRequest): { messages: any[]; hasVision: boolean } {
    const cleanedMessages: any[] = [];
    let hasVision = false;

    for (const msg of request.messages) {
      let content = msg.content;

      // String content
      if (typeof content === "string") {
        // Detect and replace agent system prompts
        if (msg.role === "system" && this.isAgentSystemPrompt(content)) {
          cleanedMessages.push({
            role: "system",
            content: "You are a helpful AI assistant that helps with software engineering tasks.",
          });
          continue;
        }
        cleanedMessages.push({ role: msg.role, content });
        continue;
      }

      // Array content — need conversion from Anthropic to OpenAI format
      if (Array.isArray(content)) {
        const hasToolUse = content.some((block: any) => block.type === "tool_use");
        const hasToolResult = content.some((block: any) => block.type === "tool_result");

        // Assistant messages with tool_use → convert to OpenAI tool_calls
        if (msg.role === "assistant" && hasToolUse) {
          const textBlocks = content.filter((block: any) => block.type === "text");
          const toolUseBlocks = content.filter((block: any) => block.type === "tool_use");

          const textContent = textBlocks
            .map((block: any) => block.text || "")
            .filter(Boolean)
            .join("\n");

          const tool_calls = toolUseBlocks.map((block: any) => ({
            id: block.id || crypto.randomUUID(),
            type: "function",
            function: {
              name: block.name || "",
              arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input || {}),
            },
          }));

          cleanedMessages.push({
            role: "assistant",
            content: textContent || "",
            tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
          });
          continue;
        }

        // User messages with tool_result → convert to OpenAI tool messages
        if (msg.role === "user" && hasToolResult) {
          const toolResults = content.filter((block: any) => block.type === "tool_result");
          const textBlocks = content.filter((block: any) => block.type === "text");

          // Add each tool result as a separate tool message
          for (const toolResult of toolResults) {
            const resultContent = typeof toolResult.content === "string"
              ? toolResult.content
              : Array.isArray(toolResult.content)
                ? toolResult.content.map((c: any) => c.text || "").join("\n")
                : JSON.stringify(toolResult.content || "");

            cleanedMessages.push({
              role: "tool",
              tool_call_id: toolResult.tool_use_id || crypto.randomUUID(),
              content: resultContent,
            });
          }

          // Add text content after tool results if present
          const textContent = textBlocks
            .map((block: any) => block.text || "")
            .filter(Boolean)
            .join("\n");

          if (textContent) {
            cleanedMessages.push({
              role: "user",
              content: textContent,
            });
          }
          continue;
        }

        // Default: build OpenAI-format content array preserving image_url blocks inline.
        // CodeBuddy China expects: content: [ {type:"image_url", image_url:{url:"..."}}, {type:"text", text:"..."} ]
        // This is the STANDARD OpenAI vision format — confirmed working with glm-4.6v,
        // glm-5v-turbo, deepseek-v3-2-volc via direct upstream testing.
        const outputContent: any[] = [];

        for (const block of content) {
          if (block.type === "text") {
            outputContent.push({ type: "text", text: block.text || "" });
          } else if (block.type === "image_url" && block.image_url) {
            // OpenAI-style image_url — pass through as-is
            const url = typeof block.image_url === "string" ? block.image_url : block.image_url.url;
            if (url) {
              outputContent.push({ type: "image_url", image_url: { url } });
              hasVision = true;
            }
          } else if (block.type === "image" && block.source) {
            // Anthropic-style image → convert to OpenAI image_url with data URL
            const base64 = block.source.type === "base64"
              ? `data:${block.source.media_type || "image/png"};base64,${block.source.data}`
              : block.source.url || "";
            if (base64) {
              outputContent.push({ type: "image_url", image_url: { url: base64 } });
              hasVision = true;
            }
          }
        }

        // If only text blocks (no images), collapse to plain string for backwards-compat
        // with non-vision models that may reject array content.
        const hasOnlyText = outputContent.every((b) => b.type === "text");
        if (hasOnlyText) {
          const flatText = outputContent.map((b: any) => b.text).join("\n");
          cleanedMessages.push({ role: msg.role, content: flatText });
        } else {
          cleanedMessages.push({ role: msg.role, content: outputContent });
        }
        continue;
      }

      // Fallback: pass through as-is
      cleanedMessages.push({ role: msg.role, content: content || "" });
    }

    return { messages: cleanedMessages, hasVision };
  }

  private isAgentSystemPrompt(content: string): boolean {
    if (content.length > 2000) return true;
    // Broad detection for AI agent/CLI tool system prompts
    const patterns = [
      /claude.*official.*cli/i,
      /code.*official.*cli/i,
      /you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)/i,
      /you are an? (?:ai )?(?:coding |code )?agent/i,
      /cc_entrypoint/i,
      /OhMyOpenCode/i,
      /<agent-identity>/i,
    ];
    return patterns.some((p) => p.test(content));
  }

  /**
   * Normalize tools from Anthropic/Claude format to OpenAI function-calling format.
   * Also sanitize schemas (resolve $ref, strip unsupported fields).
   */
  private normalizeTools(tools: any[] | undefined): any[] {
    if (!tools || tools.length === 0) return [];

    return tools.map((tool) => {
      if (tool.type === "function" && tool.function) {
        return {
          type: "function",
          function: {
            name: tool.function.name,
            description: tool.function.description || "",
            parameters: this.sanitizeToolSchema(tool.function.parameters),
          },
        };
      }

      // Convert Anthropic/Claude format to OpenAI format
      const fn = tool.function || tool;
      const name = fn?.name || tool?.name;
      const description = fn?.description || tool?.description || "";
      const parameters = fn?.parameters || fn?.input_schema || { type: "object", properties: {} };

      return {
        type: "function",
        function: {
          name,
          description,
          parameters: this.sanitizeToolSchema(parameters),
        },
      };
    }).filter((t: any) => t.function?.name);
  }

  private sanitizeToolSchema(schema: any): any {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return { type: "object", properties: {} };
    }

    const cacheKey = JSON.stringify(schema);
    const cached = this.schemaCache.get(cacheKey);
    if (cached) return cached;

    const defs = { ...(schema.$defs || {}), ...(schema.definitions || {}) };
    let resolved = Object.keys(defs).length > 0 || this.hasRefs(schema)
      ? this.resolveSchemaRefs(schema, defs)
      : { ...schema };

    for (const key of ["$schema", "$id", "$comment", "$defs", "definitions"]) {
      delete resolved[key];
    }

    if (!resolved.type) resolved.type = "object";
    if (resolved.type === "object" && !resolved.properties) {
      resolved.properties = {};
    }
    if (resolved.required && !Array.isArray(resolved.required)) {
      delete resolved.required;
    }

    if (this.schemaCache.size >= CodeBuddyChinaProvider.SCHEMA_CACHE_MAX) {
      this.schemaCache.clear();
    }
    this.schemaCache.set(cacheKey, resolved);

    return resolved;
  }

  private resolveSchemaRefs(schema: any, defs: Record<string, any>, seen = new Set<string>()): any {
    if (!schema || typeof schema !== "object") return schema;
    if (Array.isArray(schema)) return schema.map((item: any) => this.resolveSchemaRefs(item, defs, seen));

    if (schema.$ref && typeof schema.$ref === "string") {
      const refPath = schema.$ref.replace(/^#\/\$defs\//, "").replace(/^#\/definitions\//, "");
      if (seen.has(refPath)) return { type: "object", description: `(circular ref: ${refPath})` };
      const resolved = defs[refPath];
      if (resolved) {
        seen.add(refPath);
        const result = this.resolveSchemaRefs({ ...resolved }, defs, seen);
        seen.delete(refPath);
        return result;
      }
      return { type: "object" };
    }

    const clone: any = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "$defs" || key === "definitions") continue;
      clone[key] = this.resolveSchemaRefs(value, defs, seen);
    }
    return clone;
  }

  private hasRefs(obj: any): boolean {
    if (!obj || typeof obj !== "object") return false;
    if (Array.isArray(obj)) return obj.some((item: any) => this.hasRefs(item));
    if ("$ref" in obj) return true;
    return Object.values(obj).some((value: any) => this.hasRefs(value));
  }

  async chatCompletion(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "No tokens available" };

    const apiKey = this.getApiKey(tokens);
    if (!apiKey) return { success: false, error: "No API key available" };

    try {
      // Always stream — CodeBuddy China doesn't support non-stream
      const response = await this.makeRequest(apiKey, request, true);

      if (!response.ok) {
        const errText = await response.text();
        const classified = classifyCodeBuddyHttpFailure(response.status, errText, "CodeBuddy China");
        return {
          success: false,
          error: classified.sessionExpired
            ? "Session expired, re-login required"
            : classified.error,
          quotaExhausted: classified.quotaExhausted,
        };
      }

      const data = await this.aggregateStreamResponse(response, request.model);
      const totalTokens = data.usage.total_tokens || 0;
      const realCredit = (data as any)._realCredit;
      const creditsUsed = realCredit != null ? realCredit : (totalTokens > 0 ? totalTokens * this.getProviderCreditRate(request.model) : 0);
      const creditSource: "upstream" | "estimated" = realCredit != null ? "upstream" : "estimated";
      delete (data as any)._realCredit;

      return {
        success: true,
        response: data,
        tokensUsed: totalTokens,
        promptTokens: data.usage.prompt_tokens || 0,
        completionTokens: data.usage.completion_tokens || 0,
        creditsUsed,
        creditSource,
      };
    } catch (error) {
      return { success: false, error: `CodeBuddy China request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "No tokens available" };

    const apiKey = this.getApiKey(tokens);
    if (!apiKey) return { success: false, error: "No API key available" };

    try {
      const response = await this.makeRequest(apiKey, request, true);

      if (!response.ok) {
        const errText = await response.text();
        const classified = classifyCodeBuddyHttpFailure(response.status, errText, "CodeBuddy China");
        return {
          success: false,
          error: classified.sessionExpired ? "Session expired" : classified.error,
          quotaExhausted: classified.quotaExhausted,
        };
      }

      return this.createStreamResponse(response, request.model);
    } catch (error) {
      return { success: false, error: `CodeBuddy China stream failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async refreshToken(
    _account: Account
  ): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: false, error: "CodeBuddy China uses static API keys — no refresh" };
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!this.getApiKey(tokens || {} as CodeBuddyChinaTokens);
  }

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "No tokens available" };

    const apiKey = this.getApiKey(tokens);
    if (!apiKey) return { success: false, error: "No API key" };

    try {
      const response = await this.fetchUserResource(tokens);

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;
      if (data.code !== 0) {
        return { success: false, error: `API error code ${data.code}` };
      }

      const parsed = this.parseResourceQuota(data);
      if (parsed.ambiguous) {
        return { success: false, error: "ambiguous billing capacity payload" };
      }
      return { success: true, quota: parsed };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const tokens = this.getTokens(account);
    const apiKey = this.getApiKey(tokens || {} as CodeBuddyChinaTokens);
    if (!apiKey) {
      return { kind: "missing_tokens", success: false, error: "No API key available" };
    }

    // Primary check: fetch real billing data via /v2/billing/meter/get-user-resource
    // This endpoint works with API key and gives us both auth validation AND real credit data.
    const quota = await this.fetchQuota(account);
    if (quota.success && quota.quota) {
      return {
        kind: quota.quota.remaining <= 0 ? "exhausted" : "healthy",
        success: true,
        quota: { ...quota.quota, source: "codebuddy-china.get-user-resource" },
        metadata: {
          credit_total_dosage: quota.quota.limit,
          credit_capacity_remain: quota.quota.remaining,
          credit_capacity_used: quota.quota.used,
          credit_capacity_size: quota.quota.limit,
          lastRealBillingSync: new Date().toISOString(),
        },
      };
    }

    // Billing API failed — check if it's an auth issue or transient error
    if (quota.error?.includes("401") || quota.error?.includes("403")) {
      return {
        kind: "session_expired",
        success: false,
        error: "CodeBuddy China API key expired or revoked (billing returned 401/403)",
      };
    }

    // Fallback: validate via chat completions endpoint
    const apiStatus = await this.validateApiKey(tokens || {} as CodeBuddyChinaTokens);

    if (apiStatus === "ok") {
      // API works but billing failed (transient) — report as healthy with stored quota
      const storedQuota = Number(account.quotaRemaining || 0);
      const storedLimit = Number(account.quotaLimit || 0);
      return {
        kind: "healthy",
        success: true,
        quota: storedLimit > 0
          ? { limit: storedLimit, remaining: storedQuota, used: storedLimit - storedQuota, source: "tracked" }
          : undefined,
        message: `Billing API transient error (${quota.error}). Using tracked credit: ${storedQuota.toFixed(1)}/${storedLimit.toFixed(1)}`,
      };
    }

    if (apiStatus === "quota_exhausted") {
      return { kind: "exhausted", success: true, error: "Provider returned 429 - quota exhausted" };
    }

    // API returned 401/403 - truly expired
    return {
      kind: "session_expired",
      success: false,
      error: "CodeBuddy China API returned 401/403 - session expired, re-login required",
    };
  }

  /**
   * Check if the api_key can make actual requests to the provider.
   * Uses the billing API endpoint which validates the API key without consuming credits.
   * Falls back to chat completions endpoint if billing check fails.
   * Returns: "ok" | "quota_exhausted" | "expired"
   */
  private async validateApiKey(tokens: CodeBuddyChinaTokens): Promise<"ok" | "quota_exhausted" | "expired"> {
    const apiKey = this.getApiKey(tokens);
    if (!apiKey) return "expired";

    // Primary: use billing API to validate — doesn't consume credits and gives definitive auth status
    try {
      const response = await this.fetchUserResource(tokens);
      if (response.status === 401 || response.status === 403) return "expired";
      if (response.status === 429) return "quota_exhausted";
      if (response.ok) {
        const data = await response.json() as any;
        if (data.code === 0) return "ok";
        // Non-zero code but HTTP 200 — API key is valid, just a business logic error
        return "ok";
      }
      // Other HTTP errors — fall through to chat endpoint check
    } catch {
      // Network error on billing — fall through to chat endpoint check
    }

    // Fallback: use chat completions endpoint (abort immediately after status)
    const controller = new AbortController();
    try {
      const response = await fetch(`${this.baseUrl}/v2/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: this.buildHeaders(apiKey),
        body: JSON.stringify({
          model: "deepseek-v3",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 5,
          stream: true,
        }),
      });

      // Got HTTP status - abort immediately to avoid consuming tokens
      controller.abort();

      if (response.status === 401 || response.status === 403) return "expired";
      if (response.status === 429) return "quota_exhausted";
      return "ok";
    } catch (err: any) {
      // AbortError is expected (we aborted on purpose after getting status)
      if (err?.name === "AbortError") return "ok";
      // Network error - assume ok to avoid false negatives
      return "ok";
    }
  }

  private async fetchUserResource(tokens: CodeBuddyChinaTokens): Promise<Response> {
    const now = new Date();
    const endDate = new Date(now.getTime() + 365 * 20 * 24 * 60 * 60 * 1000);
    const payload = {
      PageNumber: 1,
      PageSize: 100,
      ProductCode: "p_tcaca",
      Status: [0, 3],
      PackageEndTimeRangeBegin: now.toISOString().replace("T", " ").slice(0, 19),
      PackageEndTimeRangeEnd: endDate.toISOString().replace("T", " ").slice(0, 19),
    };

    // Use /v2/billing/meter/get-user-resource which works with API key (Bearer token).
    const apiKey = this.getApiKey(tokens);
    const headers: Record<string, string> = {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
      applyCodeBuddyUserIdHeader(headers, apiKey);
    }

    return this.fetchWithTimeout(`${this.baseUrl}/v2/billing/meter/get-user-resource`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }, config.providerQuotaTimeoutMs);
  }

  private parseResourceQuota(data: any): { limit: number; remaining: number; used: number; ambiguous?: boolean } {
    return parseCodeBuddyResourceQuota(data);
  }

  private async makeRequest(
    apiKey: string,
    request: ChatCompletionRequest,
    stream: boolean
  ): Promise<Response> {
    const resolved = this.resolveModel(request.model);
    const headers = this.buildHeaders(apiKey, stream);

    // Clean messages: convert Anthropic-format (tool_use, tool_result, array content)
    // to OpenAI format (tool_calls, tool messages). Vision images stay INLINE in
    // content array (standard OpenAI format) — NOT hoisted to top-level fields.
    const { messages, hasVision } = this.cleanMessages(request);

    const body: Record<string, unknown> = {
      model: resolved,
      messages,
      stream: true, // Always stream for China version
    };

    if (hasVision) {
      // Vision images are passed inline via the messages array (OpenAI standard format).
      // CodeBuddy China upstream auto-detects and routes them — no top-level flag needed.
      // Verified accurate with glm-4.6v, glm-5v-turbo, deepseek-v3-2-volc via direct
      // upstream testing on real screenshots.
    }

    if (request.max_tokens && request.max_tokens > 0) {
      body.max_tokens = request.max_tokens;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    // Normalize tools to OpenAI function-calling format
    const tools = this.normalizeTools(request.tools);
    if (tools.length > 0) {
      body.tools = tools;
    }
    if (request.tool_choice) {
      body.tool_choice = request.tool_choice;
    }

    const timeoutMs = stream ? 300_000 : config.providerRequestTimeoutMs;

    return this.fetchWithTimeout(`${this.baseUrl}/v2/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, timeoutMs);
  }

  private async aggregateStreamResponse(response: Response, model: string): Promise<ChatCompletionResponse & { _realCredit?: number }> {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let id = this.generateId();
    let finishReason: string | null = "stop";
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let realCredit: number | null = null;

    if (!reader) {
      return {
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
        usage,
      };
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          id = chunk.id || id;
          const choice = chunk.choices?.[0];
          const delta = choice?.delta || {};

          if (delta.content) content += delta.content;

          if (choice?.finish_reason) finishReason = choice.finish_reason || "stop";

          if (chunk.usage) {
            usage = {
              prompt_tokens: Number(chunk.usage.prompt_tokens || 0),
              completion_tokens: Number(chunk.usage.completion_tokens || 0),
              total_tokens: Number(chunk.usage.total_tokens || 0),
            };
            if (chunk.usage.credit != null && Number(chunk.usage.credit) > 0) {
              realCredit = Number(chunk.usage.credit);
            }
          }
        } catch {
          // skip malformed chunk
        }
      }
    }

    if (!usage.completion_tokens) usage.completion_tokens = this.estimateTokens(content);
    if (!usage.total_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason || "stop" }],
      usage,
      ...(realCredit != null ? { _realCredit: realCredit } : {}),
    };
  }

  private createStreamResponse(response: Response, model: string): ProviderResult {
    const id = this.generateId();
    const encoder = new TextEncoder();
    let capturedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let capturedRealCredit: number | null = null;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = response.body?.getReader();
        if (!reader) { controller.close(); return; }

        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data:")) continue;
              const data = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5);

              if (data === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                continue;
              }

              try {
                const parsed = JSON.parse(data);
                const choice = parsed.choices?.[0];
                const delta = choice?.delta || {};

                const chunk: StreamChunk = {
                  id: parsed.id || id,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{
                    index: choice?.index ?? 0,
                    delta,
                    finish_reason: choice?.finish_reason || null,
                  }],
                };

                if (parsed.usage) {
                  chunk.usage = parsed.usage;
                  capturedUsage = {
                    prompt_tokens: Number(parsed.usage.prompt_tokens || 0),
                    completion_tokens: Number(parsed.usage.completion_tokens || 0),
                    total_tokens: Number(parsed.usage.total_tokens || 0),
                  };
                  if (parsed.usage.credit != null && Number(parsed.usage.credit) > 0) {
                    capturedRealCredit = Number(parsed.usage.credit);
                  }
                }

                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              } catch {
                // skip malformed chunk
              }
            }
          }
        } catch (error) {
          console.error("[CodeBuddy China] Stream error:", error instanceof Error ? error.message : String(error));
        } finally {
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    });

    return {
      success: true,
      stream,
      tokensUsed: capturedUsage.total_tokens,
      promptTokens: capturedUsage.prompt_tokens,
      completionTokens: capturedUsage.completion_tokens,
      creditsUsed: 0,
      creditSource: "estimated" as const,
    };
  }
}
