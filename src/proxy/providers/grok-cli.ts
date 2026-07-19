/**
 * Compatibility barrel — prefer `providers/grok-cli` (folder).
 * Keeps existing imports of `./grok-cli` and `./grok-cli-image` working.
 */
export * from "./grok-cli/index";
export { grokCliProvider, GrokCliProvider } from "./grok-cli/index";
