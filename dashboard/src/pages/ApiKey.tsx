import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { Copy, Eye, EyeOff, RefreshCw, Check, Save, ShieldCheck } from "lucide-react";
import { fetchApiKey, regenerateApiKey, setApiKey, testApiKey } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { toast } from "@/hooks/useToast";

export default function ApiKey() {
  const [apiKey, setApiKeyState] = useState(localStorage.getItem("api_key") || "pool-proxy-secret-key");
  const [source, setSource] = useState("browser");
  const [showKey, setShowKey] = useState(false);
  const { message, setMessage: setTimedMessage, clearMessage } = useTimedMessage<string>(null, 3500);
  const { message: copied, setMessage: setCopiedTimed } = useTimedMessage<boolean>(null, 2000);
  const [error, setError] = useState<string | null>(null);
  const [valid, setValid] = useState<boolean | null>(null);

  function notify(text: string) {
    setTimedMessage(text);
    setError(null);
  }

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
    clearMessage();
  }

  function saveToBrowser(key = apiKey) {
    localStorage.setItem("api_key", key);
    setApiKeyState(key);
  }

  async function loadKey() {
    try {
      const res = await fetchApiKey() as { key: string; source: string };
      setApiKeyState(res.key);
      setSource(res.source);
      saveToBrowser(res.key);
      setValid(true);
    } catch (err) {
      fail(err);
    }
  }

  useEffect(() => {
    loadKey();
  }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText(apiKey);
    setCopiedTimed(true);
    toast({ title: "API key copied", tone: "success" });
  };

  async function handleSave() {
    try {
      const res = await setApiKey(apiKey) as { key: string; source: string };
      saveToBrowser(res.key);
      setSource(res.source);
      setValid(true);
      notify("API key saved to backend and browser. It can now be used for proxy requests.");
      toast({ title: "API key activated", tone: "success" });
    } catch (err) {
      fail(err);
    }
  }

  async function handleRegenerate() {
    if (!confirm("Regenerate API key? Existing generated key will stop working.")) return;
    try {
      const res = await regenerateApiKey() as { key: string; source: string };
      saveToBrowser(res.key);
      setSource(res.source);
      setValid(true);
      notify("New API key generated, saved, and activated.");
      toast({ title: "API key regenerated", tone: "success" });
    } catch (err) {
      fail(err);
    }
  }

  async function handleTest() {
    try {
      const res = await testApiKey(apiKey) as { valid: boolean };
      setValid(res.valid);
      notify(res.valid ? "API key is valid." : "API key is invalid.");
      toast({
        title: res.valid ? "API key is valid" : "API key is invalid",
        tone: res.valid ? "success" : "error",
      });
    } catch (err) {
      fail(err);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Proxy"
        title="API Key"
        description="Generate and activate proxy API keys"
      />

      {(message || error) && (
        <div className={`rounded-md p-3 text-sm ${message ? "bg-[var(--success)]/10 text-[var(--success)]" : "bg-[var(--error)]/10 text-[var(--error)]"}`}>
          {message || error}
        </div>
      )}

      <Card className="border-[var(--border)] max-w-3xl">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" /> Active API Key
          </CardTitle>
          <CardDescription>
            Source: <span className="font-mono">{source}</span>. The env fallback key also remains accepted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => {
                  setApiKeyState(e.target.value);
                  setValid(null);
                }}
                className="pr-10 font-mono text-sm"
              />
              <button
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <Button variant="outline" size="icon" onClick={handleCopy} title="Copy">
              {copied ? <Check className="w-4 h-4 text-[var(--success)]" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-[var(--muted-foreground)]">Status</span>
              {valid === true && <StatusBadge status="success">valid</StatusBadge>}
              {valid === false && <StatusBadge status="error">invalid</StatusBadge>}
              {valid === null && <StatusBadge status="idle">not tested</StatusBadge>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={loadKey}>Load Active</Button>
              <Button variant="outline" size="sm" onClick={handleTest}>Test</Button>
              <Button variant="outline" size="sm" onClick={handleRegenerate}>
                <RefreshCw className="w-4 h-4 mr-2" /> Generate
              </Button>
              <Button size="sm" onClick={handleSave}>
                <Save className="w-4 h-4 mr-2" /> Save & Activate
              </Button>
            </div>
          </div>

          <div className="rounded-lg bg-[var(--secondary)] p-4 mt-4">
            <h4 className="text-sm font-medium text-[var(--foreground)] mb-2">Usage Example</h4>
            <pre className="font-mono text-xs text-[var(--muted-foreground)] overflow-x-auto">
{`curl http://localhost:1930/v1/chat/completions \\
  -H "Authorization: Bearer ${showKey ? apiKey : "sk-pool-***"}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}
            </pre>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
