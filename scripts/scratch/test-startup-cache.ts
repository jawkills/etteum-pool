import { getProviderForModel, getByokProvider, refreshByokModels } from "./src/proxy/providers/registry";

async function test() {
  console.log("=== Simulating Startup Cache Initialization ===\n");
  
  // Check initial state (should be empty like at startup)
  const byokProvider = getByokProvider();
  console.log("Initial state:");
  console.log("  Prefixes:", byokProvider["prefixes"]);
  console.log("  Cache expiry:", byokProvider["cacheExpiry"]);
  console.log("  Stale:", Date.now() >= byokProvider["cacheExpiry"]);
  console.log("");
  
  // Call refreshByokModels() like index.ts does
  console.log("Calling refreshByokModels()...");
  await refreshByokModels();
  console.log("");
  
  // Check state after refresh
  console.log("After refreshByokModels():");
  console.log("  Prefixes:", byokProvider["prefixes"]);
  console.log("  Cache expiry:", byokProvider["cacheExpiry"]);
  console.log("  Stale:", Date.now() >= byokProvider["cacheExpiry"]);
  console.log("");
  
  // Test routing
  const testModels = ["genflow-gpt-5.4", "genflow-claude-opus-4.6"];
  console.log("Routing test:");
  for (const model of testModels) {
    const provider = getProviderForModel(model);
    console.log(`  ${model} → ${provider}`);
  }
}

test().catch(console.error);
