import { getProviderForModel, getByokProvider } from "./src/proxy/providers/registry";

async function test() {
  console.log("=== Testing BYOK Routing ===\n");
  
  // Force refresh cache dulu (simulate startup)
  console.log("Force refreshing BYOK cache...");
  const byokProvider = getByokProvider();
  await byokProvider.refreshModelsCache();
  console.log("Cache refreshed");
  console.log("Prefixes:", byokProvider["prefixes"]);
  console.log("Cache expiry:", byokProvider["cacheExpiry"]);
  console.log("");
  
  const testModels = [
    "genflow-gpt-5.4",
    "genflow-claude-opus-4.6",
    "kiro-gpt-4",
    "openai-gpt-4o"
  ];

  for (const model of testModels) {
    const provider = getProviderForModel(model);
    console.log(`Model: ${model}`);
    console.log(`  → Provider: ${provider}\n`);
  }
}

test().catch(console.error);
