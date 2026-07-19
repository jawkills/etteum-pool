#!/bin/bash

echo "=== BYOK End-to-End Test ==="
echo ""

API_KEY="pool-proxy-secret-key"
AUTH="Authorization: Bearer $API_KEY"

# Check if server is already running
if curl -s -H "$AUTH" http://localhost:1930/api/accounts > /dev/null 2>&1; then
  echo "✅ Server already running on port 1930"
else
  echo "❌ Server not running. Please start with: ./etteum restart"
  exit 1
fi
echo ""

# 2. Add a BYOK provider
echo "2. Adding BYOK provider..."
CREATE_RESPONSE=$(curl -s -X POST http://localhost:1930/api/accounts/byok \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{
    "label": "testrouter",
    "base_url": "https://api.openai.com/v1",
    "api_key": "sk-test-key-123",
    "format": "openai",
    "models": ["gpt-4", "gpt-3.5-turbo"]
  }')

echo "Create response: $CREATE_RESPONSE"
echo ""

# Extract ID from response
BYOK_ID=$(echo $CREATE_RESPONSE | grep -o '"id":[0-9]*' | cut -d':' -f2)
if [ -z "$BYOK_ID" ]; then
  echo "❌ Failed to create BYOK provider"
  exit 1
fi
echo "✅ BYOK provider created (ID: $BYOK_ID)"
echo ""

# 3. List BYOK providers
echo "3. Listing BYOK providers..."
LIST_RESPONSE=$(curl -s -H "$AUTH" http://localhost:1930/api/accounts/byok)
echo "List response: $LIST_RESPONSE"
echo ""

if echo "$LIST_RESPONSE" | grep -q '"testrouter"'; then
  echo "✅ BYOK provider appears in list"
else
  echo "❌ BYOK provider not found in list"
  exit 1
fi
echo ""

# 4. Check if models appear in /v1/models
echo "4. Checking models in /v1/models..."
MODELS_RESPONSE=$(curl -s -H "$AUTH" http://localhost:1930/v1/models)

if echo "$MODELS_RESPONSE" | grep -q '"testrouter-gpt-4"'; then
  echo "✅ Model 'testrouter-gpt-4' found in /v1/models"
else
  echo "❌ Model 'testrouter-gpt-4' not found in /v1/models"
  echo "Models: $MODELS_RESPONSE"
  exit 1
fi
echo ""

# 5. Test the BYOK connection
echo "5. Testing BYOK connection..."
TEST_RESPONSE=$(curl -s -X POST -H "$AUTH" http://localhost:1930/api/accounts/byok/$BYOK_ID/test)
echo "Test response: $TEST_RESPONSE"
echo ""

# Note: This will fail because we're using a fake API key, but the endpoint should respond
if echo "$TEST_RESPONSE" | grep -q '"success"'; then
  echo "✅ Test endpoint responded"
else
  echo "❌ Test endpoint did not respond correctly"
  exit 1
fi
echo ""

# 6. Update the BYOK provider
echo "6. Updating BYOK provider..."
UPDATE_RESPONSE=$(curl -s -X PATCH -H "$AUTH" -H "Content-Type: application/json" \
  http://localhost:1930/api/accounts/byok/$BYOK_ID \
  -d '{
    "base_url": "https://api.anthropic.com/v1",
    "format": "anthropic"
  }')
echo "Update response: $UPDATE_RESPONSE"
echo ""

if echo "$UPDATE_RESPONSE" | grep -q '"success":true'; then
  echo "✅ BYOK provider updated successfully"
else
  echo "❌ Failed to update BYOK provider"
  exit 1
fi
echo ""

# 7. Delete the BYOK provider
echo "7. Deleting BYOK provider..."
DELETE_RESPONSE=$(curl -s -X DELETE -H "$AUTH" http://localhost:1930/api/accounts/byok/$BYOK_ID)
echo "Delete response: $DELETE_RESPONSE"
echo ""

if echo "$DELETE_RESPONSE" | grep -q '"success":true'; then
  echo "✅ BYOK provider deleted successfully"
else
  echo "❌ Failed to delete BYOK provider"
  exit 1
fi
echo ""

# 8. Verify models are removed
echo "8. Verifying models are removed..."
MODELS_AFTER=$(curl -s -H "$AUTH" http://localhost:1930/v1/models)
if echo "$MODELS_AFTER" | grep -q '"testrouter-gpt-4"'; then
  echo "❌ Model 'testrouter-gpt-4' still exists after deletion"
  exit 1
else
  echo "✅ Model 'testrouter-gpt-4' removed after deletion"
fi
echo ""

echo "=== All E2E tests passed! ==="
