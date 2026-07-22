import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Eye, EyeOff, Lock } from "lucide-react";
import { validateApiKey } from "@/lib/api";

interface LoginProps {
  onLogin: () => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) {
      setError("Please enter an API key");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const valid = await validateApiKey(key.trim());
      if (valid) {
        localStorage.setItem("api_key", key.trim());
        onLogin();
      } else {
        setError("Invalid API key — paste the key from .env (API_KEY=...)");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cannot reach API server");
    }
    setLoading(false);
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[var(--background)] p-4">
      <div className="pointer-events-none absolute inset-0 bg-grid-pattern opacity-60" />
      <div className="pointer-events-none absolute -top-24 right-10 h-64 w-64 rounded-full bg-[var(--primary)] opacity-10 blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-20 left-8 h-56 w-56 rounded-full bg-[var(--gold)] opacity-[0.07] blur-[100px]" />

      <Card className="relative w-full max-w-sm border-[var(--border)] shadow-[var(--shadow-card)]">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-primary">
            <Lock className="h-5 w-5 text-white" />
          </div>
          <CardTitle className="font-heading text-xl">Etteum</CardTitle>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
            Proxy ledger access
          </p>
          <p className="mt-2 text-sm text-[var(--muted-foreground)]">
            Enter your API key to access the dashboard
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <Input
                type={showKey ? "text" : "password"}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setError(null);
                }}
                placeholder="sk-pool-..."
                className="pr-10 font-mono text-sm"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute top-1/2 right-3 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>

            {error && (
              <div className="rounded-xl border border-[var(--error)]/30 bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Verifying..." : "Login"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
