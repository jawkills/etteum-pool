import { describe, expect, test } from "bun:test";
import {
  enrichTools,
  isUnknownToolError,
  mapClientTools,
  stripInjectedBuiltins,
} from "./tools";

describe("mapClientTools", () => {
  test("maps OpenAI function tools and strips custom", () => {
    const out = mapClientTools([
      { type: "function", function: { name: "foo", description: "d", parameters: { type: "object" } } },
      { type: "custom", name: "x" },
      { type: "web_search" },
    ]);
    expect(out).toEqual([
      {
        type: "function",
        name: "foo",
        description: "d",
        parameters: { type: "object" },
        strict: false,
      },
      { type: "web_search" },
    ]);
  });
});

describe("enrichTools", () => {
  test("auto-injects web_search and x_search by default", () => {
    const plan = enrichTools([], {
      autoWebSearch: true,
      autoXSearch: true,
      autoCodeInterpreter: false,
    });
    expect(plan.injectedBuiltins).toEqual(["web_search", "x_search"]);
    expect(plan.tools).toEqual([{ type: "web_search" }, { type: "x_search" }]);
    expect(plan.clientHadSearch).toBe(false);
  });

  test("does not duplicate client search tools", () => {
    const plan = enrichTools([{ type: "web_search" }], {
      autoWebSearch: true,
      autoXSearch: true,
      autoCodeInterpreter: false,
    });
    expect(plan.injectedBuiltins).toEqual(["x_search"]);
    expect(plan.clientHadSearch).toBe(true);
    expect(plan.tools?.filter((t) => t.type === "web_search").length).toBe(1);
  });

  test("stripInjectedBuiltins removes only injected", () => {
    const tools = [{ type: "function", name: "a" }, { type: "web_search" }, { type: "x_search" }];
    const stripped = stripInjectedBuiltins(tools, ["web_search", "x_search"]);
    expect(stripped).toEqual([{ type: "function", name: "a" }]);
  });
});

describe("isUnknownToolError", () => {
  test("detects unknown tool 400", () => {
    expect(isUnknownToolError(400, "unknown tool type web_search")).toBe(true);
    expect(isUnknownToolError(500, "unknown tool")).toBe(false);
    expect(isUnknownToolError(400, "invalid request body")).toBe(false);
  });
});
