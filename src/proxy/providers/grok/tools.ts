/**
 * Tool mapping + auto-inject built-in search tools for Grok Responses.
 */

import type { GrokRuntimeSettings } from "./settings";

export type ToolsPlan = {
  tools: any[] | undefined;
  /** Built-in types that were auto-injected this request. */
  injectedBuiltins: string[];
  /** True when client already had web_search / x_search. */
  clientHadSearch: boolean;
};

const BUILTIN_TYPES = new Set(["web_search", "x_search", "code_interpreter", "image_generation"]);

function builtinTypeOf(tool: any): string | null {
  if (!tool || typeof tool !== "object") return null;
  const t = String(tool.type || "").toLowerCase();
  if (BUILTIN_TYPES.has(t)) return t;
  return null;
}

/** Map OpenAI Chat tools → Responses tools; strip type:"custom". */
export function mapClientTools(clientTools: any[] | undefined | null): any[] {
  if (!Array.isArray(clientTools) || clientTools.length === 0) return [];
  return clientTools
    .filter((t: any) => t && typeof t === "object" && t.type !== "custom")
    .map((t: any) => {
      if (t.type === "function" && t.function) {
        return {
          type: "function",
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters || { type: "object", properties: {} },
          strict: false,
        };
      }
      // Already Responses-shaped or built-in — pass through.
      return t;
    });
}

/**
 * Enrich client tools with auto-injected built-ins (web_search / x_search).
 * Does not duplicate if client already sent the same built-in type.
 */
export function enrichTools(
  clientTools: any[] | undefined | null,
  settings: Pick<
    GrokRuntimeSettings,
    "autoWebSearch" | "autoXSearch" | "autoCodeInterpreter"
  >
): ToolsPlan {
  const mapped = mapClientTools(clientTools);
  const present = new Set<string>();
  for (const t of mapped) {
    const b = builtinTypeOf(t);
    if (b) present.add(b);
  }

  const clientHadSearch = present.has("web_search") || present.has("x_search");
  const injectedBuiltins: string[] = [];

  if (settings.autoWebSearch && !present.has("web_search")) {
    mapped.push({ type: "web_search" });
    injectedBuiltins.push("web_search");
    present.add("web_search");
  }
  if (settings.autoXSearch && !present.has("x_search")) {
    mapped.push({ type: "x_search" });
    injectedBuiltins.push("x_search");
    present.add("x_search");
  }
  if (settings.autoCodeInterpreter && !present.has("code_interpreter")) {
    mapped.push({ type: "code_interpreter" });
    injectedBuiltins.push("code_interpreter");
  }

  return {
    tools: mapped.length > 0 ? mapped : undefined,
    injectedBuiltins,
    clientHadSearch,
  };
}

/** Drop auto-injected built-ins (for 400 unknown-tool retry). */
export function stripInjectedBuiltins(
  tools: any[] | undefined,
  injected: string[]
): any[] | undefined {
  if (!tools?.length || !injected.length) return tools;
  const drop = new Set(injected.map((s) => s.toLowerCase()));
  const kept = tools.filter((t) => {
    const b = builtinTypeOf(t);
    return !(b && drop.has(b));
  });
  return kept.length > 0 ? kept : undefined;
}

/** Detect upstream "unknown tool" / unsupported built-in errors for degrade retry. */
export function isUnknownToolError(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const low = (body || "").toLowerCase();
  return (
    /unknown tool|unsupported tool|invalid tool|tool type|web_search|x_search|code_interpreter/.test(
      low
    ) && /tool|invalid|unknown|unsupported|not supported|unrecognized/.test(low)
  );
}
