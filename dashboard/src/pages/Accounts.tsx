import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle as DTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Plus, Upload, RefreshCw, Play, RotateCcw, Flame, ChevronDown, Loader2, Key, Pencil, Trash2, Zap, Lock, Shield, Eye, EyeOff } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { useWsEvent } from "@/hooks/useWebSocket";
import {
  completeCodexOAuthCallbackUrl,
  createAccount,
  createByokProvider,
  deleteByokProvider,
  fetchAccounts,
  fetchApi,
  fetchAuthQueue,
  fetchAutoWarmupStatus,
  fetchByokProviders,
  fetchSettings,
  fetchWarmupQueue,
  getCodexAuthorize,
  importAccounts,
  importGrokCliAccounts,
  fetchGrokFarmStatus,
  startGrokFarm,
  stopGrokFarm,
  fetchCodeBuddyFarmStatus,
  startCodeBuddyFarm,
  stopCodeBuddyFarm,
  fetchCodeBuddyFarmSettings,
  exportGithubInventory, // used by github inventory card
  startGrokReauth,
  stopGrokReauth,
  type GrokFarmStatus,
  type CodeBuddyFarmStatus,
  loginAccounts,
  loginAllAccounts,
  refreshAccountTokensBulk,
  pollCodexOAuthStatus,
  revealByokKey,
  startCodexOAuthProxy,
  stopCodexOAuth,
  testByokProvider,
  updateByokProvider,
  updateSettings,
  warmupAllAccounts,
  type AutoWarmupStatus,
  type ByokProvider,
} from "@/lib/api";

type Provider = "kiro" | "kiro-pro" | "codebuddy" | "codebuddy-china" | "canva" | "codex" | "qoder" | "gitlab-duo" | "youmind" | "grok" | "github";

type ByokFormKey = {
  id?: number;
  label: string;
  key: string;
  enabled: boolean;
  status?: string;
  errorMessage?: string | null;
};

interface Account {
  id: number;
  email: string;
  provider: Provider;
  status: string;
  quotaLimit?: number;
  quotaRemaining?: number;
}

const providers: Provider[] = ["kiro", "kiro-pro", "codebuddy", "codebuddy-china", "canva", "codex", "qoder", "gitlab-duo", "youmind", "grok", "github"];

function labelProvider(provider: string) {
  if (provider === "kiro-pro") return "Kiro Pro";
  if (provider === "codebuddy") return "CodeBuddy";
  if (provider === "codebuddy-china") return "CodeBuddy CN";
  if (provider === "github") return "GitHub";
  if (provider === "codex") return "Codex";
  if (provider === "qoder") return "Qoder";
  if (provider === "gitlab-duo") return "GitLab Duo";
  if (provider === "youmind") return "YouMind";
  if (provider === "grok") return "Grok";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export default function Accounts() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<any>(null);
  const [warmupQueue, setWarmupQueue] = useState<any>(null);
  const [warmupProgress, setWarmupProgress] = useState<Record<string, { total: number; completed: number; active: number }>>({});
  const [autoWarmup, setAutoWarmup] = useState<AutoWarmupStatus | null>(null);
  const [settingsMap, setSettingsMap] = useState<Record<string, string>>({});
  const [now, setNow] = useState<number>(Date.now());

  const [addForm, setAddForm] = useState({ email: "", password: "", provider: "kiro" as Provider, browserEngine: "camoufox", headless: false });
  const [addDialogProvider, setAddDialogProvider] = useState<Provider | null>(null);
  const [instantTokens, setInstantTokens] = useState("");
  const [cookieValue, setCookieValue] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [addMode, setAddMode] = useState<"single" | "bulk" | "instant" | "pat" | "apikey">("bulk");
  const [bulkBrowserEngine, setBulkBrowserEngine] = useState("camoufox");
  const [bulkHeadless, setBulkHeadless] = useState(true);
  const [bulkConcurrency, setBulkConcurrency] = useState(3);
  const [codexOauthBusy, setCodexOauthBusy] = useState(false);
  const [codexOauthAuthUrl, setCodexOauthAuthUrl] = useState("");
  const [codexOauthCallbackUrl, setCodexOauthCallbackUrl] = useState("");
  const [gitlabBaseUrl, setGitlabBaseUrl] = useState("https://gitlab.com");
  const [gitlabPat, setGitlabPat] = useState("");
  const [gitlabLabel, setGitlabLabel] = useState("");
  const [gitlabBusy, setGitlabBusy] = useState(false);
  const [youmindApiKey, setYoumindApiKey] = useState("");
  const [youmindBusy, setYoumindBusy] = useState(false);
  const [grokCliBusy, setGrokCliBusy] = useState(false);
  const [grokMode, setGrokMode] = useState<"farm" | "import">("farm");
  const [farmCount, setFarmCount] = useState(5);
  const [farmConcurrent, setFarmConcurrent] = useState(2);
  const [farmStatus, setFarmStatus] = useState<GrokFarmStatus | null>(null);
  const [farmBusy, setFarmBusy] = useState(false);
  const [codebuddyMode, setCodebuddyMode] = useState<"farm" | "apikey" | "bulk" | "single" | "pat">("farm");
  const [cbFarmCount, setCbFarmCount] = useState(1);
  const [cbFarmConcurrent, setCbFarmConcurrent] = useState(1);
  const [cbFarmStatus, setCbFarmStatus] = useState<CodeBuddyFarmStatus | null>(null);
  const [cbFarmBusy, setCbFarmBusy] = useState(false);
  const [codebuddyBulkApiKeys, setCodebuddyBulkApiKeys] = useState("");
  const [codebuddyApiKeyBusy, setCodebuddyApiKeyBusy] = useState(false);
  const [loginPendingDialog, setLoginPendingDialog] = useState(false);
  const [loginPendingConcurrency, setLoginPendingConcurrency] = useState(2);
  const [byokProviders, setByokProviders] = useState<ByokProvider[]>([]);
  const [byokDialogOpen, setByokDialogOpen] = useState(false);
  const [byokEditId, setByokEditId] = useState<number | null>(null);
  const [byokForm, setByokForm] = useState({
    label: "",
    base_url: "",
    api_key: "",
    format: "auto" as "openai" | "anthropic" | "auto",
    models: "",
    load_balancing_method: "round_robin" as "round_robin" | "sequential" | "least_inflight",
    keys: [{ label: "default", key: "", enabled: true }] as ByokFormKey[],
  });
  const [visibleByokSecrets, setVisibleByokSecrets] = useState<Set<string>>(new Set());
  const [revealingByokSecret, setRevealingByokSecret] = useState<string | null>(null);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codexOauthPopupRef = useRef<Window | null>(null);
  const codexOauthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const codexOauthStateRef = useRef<string | null>(null);
  const loadingRef = useRef(false);

  async function load() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const [accountsRes, queueRes, warmupQueueRes, autoWarmupRes, settingsRes] = await Promise.all([
        fetchAccounts() as Promise<{ data: Account[] }>,
        fetchAuthQueue().catch(() => null),
        fetchWarmupQueue().catch(() => null),
        fetchAutoWarmupStatus().catch(() => null),
        fetchSettings().catch(() => null) as Promise<{ data: Record<string, string> } | null>,
      ]);
      setAccounts(accountsRes.data || []);
      setQueue(queueRes);
      setWarmupQueue(warmupQueueRes);
      setAutoWarmup(autoWarmupRes);
      setSettingsMap(settingsRes?.data || {});
      updateWarmupQueue(warmupQueueRes);

      // Load BYOK providers
      const byokRes = await fetchByokProviders();
      setByokProviders(byokRes.providers || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    return () => {
      if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!autoWarmup?.nextRunAt) return;
    const targetMs = new Date(autoWarmup.nextRunAt).getTime();
    let refetched = false;
    const tick = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (!refetched && current >= targetMs) {
        refetched = true;
        setTimeout(() => {
          fetchAutoWarmupStatus().then(setAutoWarmup).catch(() => {});
          load();
        }, 1500);
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [autoWarmup?.nextRunAt]);

  const reloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warmupReloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleReload = () => {
    if (reloadRef.current) clearTimeout(reloadRef.current);
    reloadRef.current = setTimeout(() => { load(); }, 800);
  };

  function updateWarmupQueue(res: any) {
    if (!res?.data || typeof res.data !== "object") {
      setWarmupProgress({});
      return;
    }
    const next: Record<string, { total: number; completed: number; active: number }> = {};
    for (const [provider, val] of Object.entries(res.data)) {
      const info = val as any;
      const total = Number(info.total || 0);
      const completed = Number(info.completed || 0);
      const active = Number(info.active || 0);
      if (total > 0) {
        next[provider] = { total, completed, active };
      }
    }
    setWarmupProgress(next);
  }

  const warmupThrottleRef = useRef(false);
  const scheduleWarmupReload = () => {
    // Throttle: fire at most once per 800ms (not debounce which starves on rapid events)
    if (warmupThrottleRef.current) return;
    warmupThrottleRef.current = true;
    setTimeout(async () => {
      warmupThrottleRef.current = false;
      try {
        const res = await fetchWarmupQueue();
        updateWarmupQueue(res);
      } catch {}
    }, 800);
  };

  useEffect(() => () => {
    if (reloadRef.current) clearTimeout(reloadRef.current);
    if (warmupReloadRef.current) clearTimeout(warmupReloadRef.current);
    if (codexOauthPollRef.current) clearInterval(codexOauthPollRef.current);
    if (codexOauthStateRef.current) {
      stopCodexOAuth(codexOauthStateRef.current).catch(() => {});
    }
    codexOauthPopupRef.current?.close();
  }, []);

  useEffect(() => {
    const pollId = codexOauthPollRef.current;
    return () => {
      if (pollId) clearInterval(pollId);
    };
  }, []);

  useWsEvent(["auto_warmup_status"], (msg) => {
    setAutoWarmup(msg.data);
  });

  useWsEvent([
    "warmup_queue_added", "warmup_processing",
    "warmup_success", "warmup_exhausted",
    "warmup_auth_error", "warmup_transient_error",
  ], scheduleWarmupReload);

  useWsEvent(["warmup_complete"], (msg) => {
    const provider = msg.data?.provider;
    if (provider) {
      // Show 100% briefly before clearing
      setWarmupProgress((prev) => {
        const existing = prev[provider];
        if (existing) return { ...prev, [provider]: { ...existing, completed: existing.total, active: 0 } };
        return prev;
      });
      // Clear after 2s so user sees completion
      setTimeout(() => {
        setWarmupProgress((prev) => {
          const next = { ...prev };
          delete next[provider];
          return next;
        });
      }, 2000);
    }
    scheduleReload();
  });

  useWsEvent(["warmup_queue_cleared"], () => {
    setWarmupProgress({});
  });

  useWsEvent(["account_status"], scheduleReload);

  useWsEvent(["byok_created", "byok_updated", "byok_deleted"], async () => {
    const byokRes = await fetchByokProviders();
    setByokProviders(byokRes.providers || []);
  });

  useWsEvent(
    ["grok_farm_status", "grok_farm_started", "grok_farm_complete", "grok_farm_progress", "grok_farm_success", "grok_farm_failed"],
    (msg) => {
      // Status broadcasts carry full GrokFarmStatus; progress events may only have log payload
      if (msg.type === "grok_farm_status" || msg.type === "grok_farm_started" || msg.type === "grok_farm_complete") {
        if (msg.data && typeof (msg.data as any).running === "boolean") {
          setFarmStatus(msg.data as GrokFarmStatus);
        }
      }
      if (msg.type === "grok_farm_complete" || msg.type === "grok_farm_success") {
        load().catch(() => {});
      }
    }
  );

  useWsEvent(
    [
      "codebuddy_farm_status",
      "codebuddy_farm_started",
      "codebuddy_farm_complete",
      "codebuddy_farm_progress",
      "codebuddy_farm_success",
      "codebuddy_farm_failed",
    ],
    (msg) => {
      if (
        msg.type === "codebuddy_farm_status" ||
        msg.type === "codebuddy_farm_started" ||
        msg.type === "codebuddy_farm_complete"
      ) {
        if (msg.data && typeof (msg.data as any).running === "boolean") {
          setCbFarmStatus(msg.data as CodeBuddyFarmStatus);
        }
      }
      if (msg.type === "codebuddy_farm_complete" || msg.type === "codebuddy_farm_success") {
        load().catch(() => {});
      }
    }
  );

  // Reauth refreshes existing rows — reload list without inventing "created" accounts.
  useWsEvent(
    ["grok_reauth_complete", "grok_reauth_success", "accounts_updated"],
    (msg) => {
      if (
        msg.type === "grok_reauth_complete" ||
        msg.type === "grok_reauth_success" ||
        (msg.type === "accounts_updated" && (msg.data as any)?.provider === "grok")
      ) {
        load().catch(() => {});
      }
    }
  );

  useEffect(() => {
    // Always poll while farm running (banner); also while Grok dialog open
    const dialogOpen = addDialogProvider === "grok";
    const running = farmStatus?.running === true;
    if (!dialogOpen && !running) {
      // one-shot fetch on mount for residual status
      if (!farmStatus) {
        fetchGrokFarmStatus()
          .then((res: any) => { if (res?.data) setFarmStatus(res.data); })
          .catch(() => {});
      }
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetchGrokFarmStatus() as { data?: GrokFarmStatus };
        if (!cancelled && res?.data) setFarmStatus(res.data);
      } catch { /* ignore poll errors */ }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [addDialogProvider, farmStatus?.running]);

  useEffect(() => {
    const dialogOpen = addDialogProvider === "codebuddy";
    const running = cbFarmStatus?.running === true;
    if (!dialogOpen && !running) {
      if (!cbFarmStatus) {
        fetchCodeBuddyFarmStatus()
          .then((res: any) => { if (res?.data) setCbFarmStatus(res.data); })
          .catch(() => {});
      }
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetchCodeBuddyFarmStatus() as { data?: CodeBuddyFarmStatus };
        if (!cancelled && res?.data) setCbFarmStatus(res.data);
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [addDialogProvider, cbFarmStatus?.running]);

  useEffect(() => {
    if (addDialogProvider !== "codebuddy") return;
    fetchCodeBuddyFarmSettings()
      .then((res: any) => {
        const d = res?.data?.defaults;
        if (d?.count) setCbFarmCount(Number(d.count) || 1);
        if (d?.concurrent) setCbFarmConcurrent(Number(d.concurrent) || 1);
      })
      .catch(() => {});
  }, [addDialogProvider]);

  async function handleToggleAutoWarmup(provider: Provider) {
    const key = `auto_warmup_provider_${provider}`;
    const next = settingsMap[key] === "true" ? "false" : "true";
    setSettingsMap((current) => ({ ...current, [key]: next }));
    try {
      await updateSettings({ [key]: next });
      const status = await fetchAutoWarmupStatus();
      setAutoWarmup(status);
      showSuccess(`Auto WarmUp ${next === "true" ? "enabled" : "disabled"} for ${labelProvider(provider)}`);
    } catch (err) {
      setSettingsMap((current) => ({ ...current, [key]: next === "true" ? "false" : "true" }));
      showError(err);
    }
  }

  function autoWarmupEnabledFor(provider: Provider): boolean {
    return settingsMap[`auto_warmup_provider_${provider}`] === "true";
  }

  function countdownLabel(): string {
    if (!autoWarmup?.nextRunAt) return "—";
    const remaining = Math.max(0, new Date(autoWarmup.nextRunAt).getTime() - now);
    const totalSeconds = Math.floor(remaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }

  function showSuccess(text: string) {
    setMessage(text);
    setError(null);
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    messageTimerRef.current = setTimeout(() => setMessage(null), 4000);
  }
  function showError(err: unknown) { setError(err instanceof Error ? err.message : String(err)); setMessage(null); }

  async function handleAdd() {
    if (!addDialogProvider) return;
    try {
      const payload: any = { email: addForm.email, password: addForm.password, provider: addDialogProvider, headless: addForm.headless, browserEngine: addForm.browserEngine };
      await createAccount(payload);
      showSuccess("Account added and bot login started.");
      setAddForm({ email: "", password: "", provider: "kiro", browserEngine: "camoufox", headless: false });
      setAddDialogProvider(null);
      await load();
      navigate("/bot-logs");
    } catch (err) { showError(err); }
  }

  async function handleInstantLogin() {
    if (!instantTokens.trim()) { showError(new Error("Paste refresh tokens (one per line)")); return; }
    const tokens = instantTokens.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    if (tokens.length === 0) { showError(new Error("No valid tokens found")); return; }

    try {
      const res = await fetchApi<{ success: number; failed: number; errors?: string[] }>("/api/accounts/instant-login", {
        method: "POST",
        body: JSON.stringify({ tokens, provider: addDialogProvider }),
      });
      showSuccess(`Instant login: ${res.success} success, ${res.failed} failed`);
      setInstantTokens("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
  }

  async function handleCookieLogin() {
    if (!cookieValue.trim()) { showError(new Error("Paste Personal Access Token (PAT)")); return; }
    try {
      const res = await fetchApi<any>("/api/accounts", {
        method: "POST",
        body: JSON.stringify({
          provider: "qoder",
          personalToken: cookieValue.trim(),
        }),
      });
      showSuccess("Qoder account added successfully");
      setCookieValue("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
  }

  async function handleGitlabPatLogin() {
    const pat = gitlabPat.trim();
    if (!pat) { showError(new Error("Paste GitLab Personal Access Token")); return; }
    const baseUrl = (gitlabBaseUrl || "https://gitlab.com").trim().replace(/\/$/, "");
    setGitlabBusy(true);
    try {
      const res = await fetchApi<any>("/api/accounts/gitlab-duo", {
        method: "POST",
        body: JSON.stringify({
          gitlab_base_url: baseUrl,
          pat,
          label: gitlabLabel.trim() || undefined,
        }),
      });
      const labelText = res?.account?.email || res?.email || "account";
      showSuccess(`GitLab Duo ${labelText} added successfully`);
      setGitlabPat("");
      setGitlabLabel("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
    finally { setGitlabBusy(false); }
  }

  async function handleYouMindApiKeyLogin() {
    const apiKey = youmindApiKey.trim();
    if (!apiKey) { showError(new Error("Paste YouMind API key")); return; }
    if (!apiKey.startsWith("sk-ym-")) {
      showError(new Error("YouMind API key must start with sk-ym-"));
      return;
    }
    setYoumindBusy(true);
    try {
      const res = await fetchApi<any>("/api/accounts", {
        method: "POST",
        body: JSON.stringify({
          provider: "youmind",
          apiKey,
        }),
      });
      const labelText = res?.email || "account";
      showSuccess(res?.updated
        ? `YouMind key updated (${labelText})`
        : `YouMind ${labelText} added successfully`);
      setYoumindApiKey("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
    finally { setYoumindBusy(false); }
  }

  async function handleGrokCliImport() {
    if (!bulkText.trim()) { showError(new Error("Paste CPA JSON (object, array, or NDJSON)")); return; }
    setGrokCliBusy(true);
    try {
      const res = await importGrokCliAccounts({ text: bulkText }) as { imported?: number; failed?: number };
      const imported = res?.imported ?? 0;
      const failed = res?.failed ?? 0;
      showSuccess(`Grok import: ${imported} imported, ${failed} failed`);
      setBulkText("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
    finally { setGrokCliBusy(false); }
  }

  async function handleGrokFarmStart() {
    const count = Math.max(1, Math.floor(farmCount) || 1);
    const concurrent = Math.max(1, Math.floor(farmConcurrent) || 1);
    setFarmBusy(true);
    try {
      const res = await startGrokFarm({ count, concurrent }) as { data?: GrokFarmStatus };
      if (res?.data) setFarmStatus(res.data);
      showSuccess("Grok farm started — progress in Bot Logs");
      setAddDialogProvider(null);
      navigate("/bot-logs");
    } catch (err) { showError(err); }
    finally { setFarmBusy(false); }
  }

  async function handleGrokFarmStop() {
    setFarmBusy(true);
    try {
      const res = await stopGrokFarm() as { data?: GrokFarmStatus };
      if (res?.data) setFarmStatus(res.data);
      showSuccess("Grok farm stop requested");
    } catch (err) { showError(err); }
    finally { setFarmBusy(false); }
  }

  async function handleCodeBuddyFarmStart() {
    const count = Math.max(1, Math.floor(cbFarmCount) || 1);
    const concurrent = Math.max(1, Math.floor(cbFarmConcurrent) || 1);
    setCbFarmBusy(true);
    try {
      const res = await startCodeBuddyFarm({ count, concurrent }) as { data?: CodeBuddyFarmStatus };
      if (res?.data) setCbFarmStatus(res.data);
      showSuccess("CodeBuddy farm started — progress in Bot Logs");
      setAddDialogProvider(null);
      navigate("/bot-logs");
    } catch (err) { showError(err); }
    finally { setCbFarmBusy(false); }
  }

  async function handleCodeBuddyFarmStop() {
    setCbFarmBusy(true);
    try {
      const res = await stopCodeBuddyFarm() as { data?: CodeBuddyFarmStatus };
      if (res?.data) setCbFarmStatus(res.data);
      showSuccess("CodeBuddy farm stop requested");
    } catch (err) { showError(err); }
    finally { setCbFarmBusy(false); }
  }

  async function handleCodeBuddyBulkApiKey(provider: "codebuddy" | "codebuddy-china") {
    const keysText = codebuddyBulkApiKeys.trim();
    const label = provider === "codebuddy-china" ? "CodeBuddy China" : "CodeBuddy";
    if (!keysText) { showError(new Error(`Paste ${label} API keys`)); return; }

    const keys = keysText.split("\n").map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) { showError(new Error("No valid API keys found")); return; }

    // Never echo key material into toasts — only report line numbers.
    const badLines: number[] = [];
    keys.forEach((key, i) => {
      if (!key.startsWith("ck_")) badLines.push(i + 1);
    });
    if (badLines.length > 0) {
      showError(new Error(
        `Invalid API key format on line ${badLines.join(", ")} (must start with ck_)`,
      ));
      return;
    }

    setCodebuddyApiKeyBusy(true);
    try {
      const res = await fetchApi<any>("/api/accounts", {
        method: "POST",
        body: JSON.stringify({
          provider,
          apiKeys: keysText,
        }),
      });
      showSuccess(`Added ${res.count} ${label} account(s) successfully`);
      setCodebuddyBulkApiKeys("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
    finally { setCodebuddyApiKeyBusy(false); }
  }

  async function handleCodeBuddySessionImport() {
    const raw = cookieValue.trim();
    if (!raw) { showError(new Error("Paste CodeBuddy JWT, ck_ key, or session JSON")); return; }
    setCodebuddyApiKeyBusy(true);
    try {
      let session: unknown = raw;
      if (raw.startsWith("{") || raw.startsWith("[")) {
        try { session = JSON.parse(raw); }
        catch { showError(new Error("Invalid JSON session payload")); return; }
      }
      const res = await fetchApi<any>("/api/accounts", {
        method: "POST",
        body: JSON.stringify({
          provider: "codebuddy",
          session,
          email: addForm.email.trim() || undefined,
        }),
      });
      showSuccess(res?.updated
        ? `CodeBuddy session updated (${res.email || "account"})`
        : `CodeBuddy ${res?.email || "session"} added`);
      setCookieValue("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
    finally { setCodebuddyApiKeyBusy(false); }
  }

  async function handleBulkImport() {
    if (!addDialogProvider || !bulkText.trim()) { showError(new Error("Paste email|password lines")); return; }
    try {
      const opts: any = { headless: bulkHeadless, browserEngine: bulkBrowserEngine, concurrency: bulkConcurrency };
      const res = await importAccounts(bulkText, [addDialogProvider], opts) as any;
      showSuccess(res.message || "Bulk import queued.");
      setBulkText("");
      setAddDialogProvider(null);
      await load();
      navigate("/bot-logs");
    } catch (err) { showError(err); }
  }

  function clearCodexOAuthPolling() {
    if (codexOauthPollRef.current) {
      clearInterval(codexOauthPollRef.current);
      codexOauthPollRef.current = null;
    }
  }

  function resetCodexOAuthFlow() {
    clearCodexOAuthPolling();
    codexOauthPopupRef.current?.close();
    codexOauthPopupRef.current = null;
    codexOauthStateRef.current = null;
    setCodexOauthBusy(false);
    setCodexOauthAuthUrl("");
    setCodexOauthCallbackUrl("");
  }

  async function safeCopyText(text: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(text);
      showSuccess(successMessage);
    } catch (err) {
      showError(err);
    }
  }

  function isCodexCallbackUrlValid(value: string) {
    try {
      const url = new URL(value.trim());
      return !!url.searchParams.get("code") && !!url.searchParams.get("state");
    } catch {
      return false;
    }
  }

  const hasPreparedCodexOAuth = !!codexOauthStateRef.current && !!codexOauthAuthUrl;
  const codexCallbackReady = isCodexCallbackUrlValid(codexOauthCallbackUrl);
  const codexCallbackExample = "http://localhost:1455/auth/callback?code=...&state=...";
  const codexLoopbackUrl = "http://localhost:1455/auth/callback";

  async function startCodexOAuthSession() {
    const redirectUri = codexLoopbackUrl;
    const appPort = window.location.port || (window.location.protocol === "https:" ? "443" : "80");
    const auth = await getCodexAuthorize(redirectUri);
    await startCodexOAuthProxy({
      appPort,
      state: auth.state,
      codeVerifier: auth.codeVerifier,
      redirectUri: auth.redirectUri,
    });
    codexOauthStateRef.current = auth.state;
    setCodexOauthAuthUrl(auth.authUrl);
    setCodexOauthCallbackUrl("");
    return auth;
  }

  function finishCodexOAuthSuccess(status: Awaited<ReturnType<typeof pollCodexOAuthStatus>>) {
    resetCodexOAuthFlow();
    showSuccess(`Codex connected: ${status.connection?.displayName || status.connection?.email || "account added"}`);
    setAddDialogProvider(null);
    load();
  }

  function beginCodexOAuthPolling() {
    clearCodexOAuthPolling();
    codexOauthPollRef.current = setInterval(async () => {
      const state = codexOauthStateRef.current;
      if (!state) return;

      try {
        const status = await pollCodexOAuthStatus(state);
        if (status.status === "done") {
          finishCodexOAuthSuccess(status);
          return;
        }

        if (status.status === "error" || status.status === "cancelled" || status.status === "not_found" || status.status === "unknown") {
          resetCodexOAuthFlow();
          showError(new Error(status.error || "Codex OAuth failed"));
        }
      } catch (pollError) {
        resetCodexOAuthFlow();
        showError(pollError);
      }
    }, 1500);
  }

  async function handleCodexOAuthLogin() {
    if (codexOauthBusy) return;
    setCodexOauthBusy(true);
    setError(null);

    try {
      const auth = await startCodexOAuthSession();
      codexOauthPopupRef.current = window.open(auth.authUrl, "codex_oauth_popup", "width=640,height=800");
      if (!codexOauthPopupRef.current) {
        window.open(auth.authUrl, "_blank", "noopener,noreferrer");
      }
      beginCodexOAuthPolling();
    } catch (err) {
      resetCodexOAuthFlow();
      showError(err);
    }
  }

  async function handleCodexOAuthPrepareManual() {
    if (codexOauthBusy || hasPreparedCodexOAuth) return;
    setCodexOauthBusy(true);
    setError(null);

    try {
      await startCodexOAuthSession();
      beginCodexOAuthPolling();
      setCodexOauthBusy(false);
      showSuccess("Auth URL ready. Open it, login, lalu paste callback URL di bawah.");
    } catch (err) {
      resetCodexOAuthFlow();
      showError(err);
    }
  }

  async function handleCodexOAuthSubmitManual() {
    if (codexOauthBusy || !codexCallbackReady) return;
    setCodexOauthBusy(true);
    setError(null);

    try {
      await completeCodexOAuthCallbackUrl(codexOauthCallbackUrl);
      const state = codexOauthStateRef.current;
      if (!state) {
        resetCodexOAuthFlow();
        showSuccess("Codex connected");
        setAddDialogProvider(null);
        await load();
        return;
      }
      const status = await pollCodexOAuthStatus(state);
      finishCodexOAuthSuccess(status);
    } catch (err) {
      setCodexOauthBusy(false);
      showError(err);
    }
  }

  async function handleCodexOAuthCopyAuthUrl() {
    if (!codexOauthAuthUrl) return;
    await safeCopyText(codexOauthAuthUrl, "Auth URL copied");
  }

  function handleCodexOAuthOpenManual() {
    if (!codexOauthAuthUrl) return;
    window.open(codexOauthAuthUrl, "_blank", "noopener,noreferrer");
  }

  async function handleCodexOAuthPasteCallback() {
    try {
      const text = await navigator.clipboard.readText();
      setCodexOauthCallbackUrl(text);
    } catch (err) {
      showError(err);
    }
  }

  async function handleExportGithub(includePassword = false) {
    try {
      await exportGithubInventory({ format: "txt", includePassword });
      showSuccess(includePassword ? "Exported GitHub inventory (with passwords)" : "Exported GitHub inventory");
    } catch (err) {
      showError(err);
    }
  }

  function handleOpenAddDialog(provider: Provider) {
    resetCodexOAuthFlow();
    if (provider === "codex") {
      setAddMode("pat");
    }
    if (provider === "gitlab-duo") {
      setAddMode("pat");
    }
    if (provider === "youmind") {
      setAddMode("pat");
    }
    if (provider === "grok") {
      setGrokMode("farm");
      setBulkText("");
      setAddMode("bulk");
    }
    if (provider === "codebuddy-china") {
      setAddMode("apikey");
    }
    if (provider === "codebuddy") {
      setCodebuddyMode("farm");
      setAddMode("bulk");
    }
    setAddDialogProvider(provider);
  }

  function handleCloseAddDialog() {
    const state = codexOauthStateRef.current;
    resetCodexOAuthFlow();
    if (state) {
      stopCodexOAuth(state).catch(() => {});
    }
    setCodebuddyBulkApiKeys("");
    setAddDialogProvider(null);
  }

  function handleSetCodexMode(mode: typeof addMode) {
    if (mode === addMode) return;
    const state = codexOauthStateRef.current;
    resetCodexOAuthFlow();
    if (state) {
      stopCodexOAuth(state).catch(() => {});
    }
    setAddMode(mode);
  }

  async function handleLoginAll() {
    setLoginPendingDialog(true);
  }

  async function confirmLoginAll() {
    setLoginPendingDialog(false);
    try {
      const res = await loginAllAccounts({ concurrency: loginPendingConcurrency }) as any;
      showSuccess(res.message || "Login all queued.");
      await load();
      navigate("/bot-logs");
    } catch (err) { showError(err); }
  }

  async function handleWarmupProvider(provider: Provider) {
    try {
      const res = await warmupAllAccounts({ providers: [provider], statuses: ["active", "exhausted", "error"] }) as any;
      showSuccess(res.message || `${labelProvider(provider)} WarmUp queued.`);
      // Immediately set progress to show the bar (don't wait for WS event / fetch)
      const count = res.count || 0;
      if (count > 0) {
        setWarmupProgress((prev) => ({ ...prev, [provider]: { total: count, completed: 0, active: 0 } }));
      }
      // Delay load slightly to let server finish enqueueing before we fetch progress
      setTimeout(() => { load(); }, 300);
    } catch (err) { showError(err); }
  }

  async function handleRetryErrors(provider: Provider) {
    const ids = accounts.filter((a) => a.provider === provider && a.status === "error").map((a) => a.id);
    if (ids.length === 0) return;
    await loginAccounts(ids);
    showSuccess(`Queued ${ids.length} ${labelProvider(provider)} error accounts for retry.`);
    await load();
  }

  /** Grok: server-side force OAuth refresh (no client string-matching death policy). */
  async function handleGrokRefreshTokens() {
    try {
      showSuccess("Refreshing Grok tokens (server bulk)…");
      const res = (await refreshAccountTokensBulk({
        provider: "grok",
        limit: 50,
        concurrency: 5,
      })) as { total?: number; ok?: number; dead?: number; fail?: number; error?: string };
      if (res.error) {
        showError(new Error(res.error));
        return;
      }
      showSuccess(
        `Grok refresh: ${res.ok ?? 0} ok, ${res.dead ?? 0} dead, ${res.fail ?? 0} fail / ${res.total ?? 0}`
      );
      await load();
    } catch (err) {
      showError(err);
    }
  }

  /** Grok: re-login dead accounts that have stored password (or GROK_PASSWORD). */
  async function handleGrokReauthDead() {
    try {
      showSuccess("Starting Grok reauth for dead accounts…");
      const res = (await startGrokReauth({
        onlyDead: true,
        concurrent: 2,
      })) as { data?: { target?: number }; skipped?: number; error?: string };
      if ((res as any).error) {
        showError(new Error((res as any).error));
        return;
      }
      showSuccess(
        `Grok reauth started: target=${res.data?.target ?? "?"} (skipped no-password=${res.skipped ?? 0}). Watch Login Logs.`
      );
    } catch (err) {
      showError(err);
    }
  }

  const BYOK_KEY_PLACEHOLDER = "••••••••";

  const emptyByokForm = () => ({
    label: "",
    base_url: "",
    api_key: "",
    format: "auto" as "openai" | "anthropic" | "auto",
    models: "",
    load_balancing_method: "round_robin" as "round_robin" | "sequential" | "least_inflight",
    keys: [{ label: "default", key: "", enabled: true }] as ByokFormKey[],
  });

  function byokSecretVisibilityId(key: ByokFormKey, index: number) {
    return key.id ? `id-${key.id}` : `new-${index}`;
  }

  async function toggleByokSecretVisibility(key: ByokFormKey, index: number) {
    const visibilityId = byokSecretVisibilityId(key, index);
    const isVisible = visibleByokSecrets.has(visibilityId);

    if (isVisible) {
      setVisibleByokSecrets((current) => {
        const next = new Set(current);
        next.delete(visibilityId);
        return next;
      });
      return;
    }

    if (key.id && key.key === BYOK_KEY_PLACEHOLDER) {
      setRevealingByokSecret(visibilityId);
      try {
        const revealed = await revealByokKey(key.id);
        updateByokKeyRow(index, { key: revealed.key });
      } catch (err) {
        showError(err);
        setRevealingByokSecret(null);
        return;
      }
      setRevealingByokSecret(null);
    }

    setVisibleByokSecrets((current) => {
      const next = new Set(current);
      next.add(visibilityId);
      return next;
    });
  }

  function addByokKeyRow() {
    setByokForm((form) => ({
      ...form,
      keys: [...form.keys, { label: `key-${form.keys.length + 1}`, key: "", enabled: true }],
    }));
  }

  function updateByokKeyRow(index: number, patch: Partial<ByokFormKey>) {
    setByokForm((form) => ({
      ...form,
      keys: form.keys.map((key, i) => i === index ? { ...key, ...patch } : key),
    }));
  }

  function removeByokKeyRow(index: number) {
    setByokForm((form) => ({
      ...form,
      keys: form.keys.length <= 1
        ? [{ label: "default", key: "", enabled: true }]
        : form.keys.filter((_, i) => i !== index),
    }));
  }

  function buildByokKeyPayload(isEdit: boolean) {
    return byokForm.keys.map((key, index) => ({
      id: key.id,
      label: key.label.trim().toLowerCase() || `key-${index + 1}`,
      key: key.key && key.key !== BYOK_KEY_PLACEHOLDER ? key.key.trim() : undefined,
      enabled: key.enabled,
      priority: index,
    })).filter((key) => isEdit || Boolean(key.key));
  }

  async function handleAddByok() {
    if (!byokForm.label || !byokForm.base_url || !byokForm.models) {
      showError(new Error("Provider name, base URL, and models are required"));
      return;
    }

    const models = byokForm.models.split(",").map(m => m.trim()).filter(Boolean);
    const apiKeys = buildByokKeyPayload(false);
    if (models.length === 0) {
      showError(new Error("At least one model is required"));
      return;
    }
    if (apiKeys.length === 0) {
      showError(new Error("Add at least one API key"));
      return;
    }

    try {
      const created = await createByokProvider({
        label: byokForm.label.trim().toLowerCase(),
        base_url: byokForm.base_url.trim(),
        api_keys: apiKeys,
        format: byokForm.format,
        load_balancing_method: byokForm.load_balancing_method,
        models,
      });
      showSuccess(`BYOK provider "${created.label}" created with ${created.key_count || apiKeys.length} key(s)`);
      setByokForm(emptyByokForm());
      setByokEditId(null);
      setByokDialogOpen(false);
      await load();
    } catch (err) {
      showError(err);
    }
  }

  async function handleUpdateByok() {
    if (byokEditId === null) return;
    if (!byokForm.base_url || !byokForm.models) {
      showError(new Error("Base URL and models are required"));
      return;
    }

    const models = byokForm.models.split(",").map(m => m.trim()).filter(Boolean);
    const apiKeys = buildByokKeyPayload(true);
    if (models.length === 0) {
      showError(new Error("At least one model is required"));
      return;
    }
    if (apiKeys.length === 0) {
      showError(new Error("At least one key row is required"));
      return;
    }

    try {
      await updateByokProvider(byokEditId, {
        base_url: byokForm.base_url.trim(),
        format: byokForm.format,
        load_balancing_method: byokForm.load_balancing_method,
        models,
        api_keys: apiKeys,
      });
      showSuccess(`BYOK provider "${byokForm.label}" updated successfully`);
      setByokForm(emptyByokForm());
      setByokEditId(null);
      setByokDialogOpen(false);
      await load();
    } catch (err) {
      showError(err);
    }
  }

  function copyByokModel(model: string) {
    navigator.clipboard?.writeText(model).then(() => {
      showSuccess(`Copied ${model}`);
    }).catch(() => showError(new Error("Clipboard not available")));
  }

  function handleEditByok(provider: ByokProvider) {
    setByokEditId(provider.id);
    setByokForm({
      label: provider.label,
      base_url: provider.base_url,
      api_key: BYOK_KEY_PLACEHOLDER,
      format: provider.format,
      models: provider.models.join(", "),
      load_balancing_method: provider.load_balancing_method || "round_robin",
      keys: (provider.keys && provider.keys.length > 0
        ? provider.keys.map((key, index) => ({
            id: key.id,
            label: key.label,
            key: BYOK_KEY_PLACEHOLDER,
            enabled: key.enabled !== false,
            status: key.status,
            errorMessage: key.errorMessage,
          }))
        : [{ id: provider.id, label: "default", key: BYOK_KEY_PLACEHOLDER, enabled: true }]) as ByokFormKey[],
    });
    setByokDialogOpen(true);
  }

  function handleCloseByokDialog() {
    setByokForm(emptyByokForm());
    setByokEditId(null);
    setByokDialogOpen(false);
  }

  async function handleTestByok(id: number, label: string) {
    try {
      const result = await testByokProvider(id);
      if (result.success) {
        const latency = result.latency_ms ? ` · ${result.latency_ms}ms` : "";
        const fixed = result.auto_fixed ? " — auto-fixed to active!" : "";
        showSuccess(`✓ ${label} OK (format: ${result.format}, model: ${result.model}${latency})${fixed}`);
        if (result.auto_fixed) await load();
      } else {
        showError(new Error(result.error || "Connection test failed"));
      }
    } catch (err) {
      showError(err);
    }
  }

  async function handleDeleteByok(id: number, label: string) {
    if (!confirm(`Delete BYOK provider "${label}"? This cannot be undone.`)) return;

    try {
      await deleteByokProvider(id);
      showSuccess(`BYOK provider "${label}" deleted`);
      await load();
    } catch (err) {
      showError(err);
    }
  }

  const providerStats = useMemo(() => {
    return providers.map((provider) => {
      const rows = accounts.filter((a) => a.provider === provider);
      const quotaLimit = rows.reduce((sum, a) => sum + (a.quotaLimit || 0), 0);
      const quotaRemaining = rows.reduce((sum, a) => sum + (a.quotaRemaining || 0), 0);
      return {
        provider,
        total: rows.length,
        active: rows.filter((a) => a.status === "active").length,
        exhausted: rows.filter((a) => a.status === "exhausted").length,
        pending: rows.filter((a) => a.status === "pending").length,
        error: rows.filter((a) => a.status === "error").length,
        credits: { used: Math.max(0, quotaLimit - quotaRemaining), total: quotaLimit, remaining: quotaRemaining },
      };
    });
  }, [accounts]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Accounts</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">Manage provider accounts</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={handleLoginAll}>
            <Play className="w-4 h-4 mr-2" /> Login Pending
          </Button>
        </div>
      </div>

      {/* Messages */}
      {(message || error) && (
        <div className={`rounded-md p-3 text-sm ${message ? "bg-[var(--success)]/10 text-[var(--success)]" : "bg-[var(--error)]/10 text-[var(--error)]"}`}>
          {message || error}
        </div>
      )}

      {/* Queue status - Login */}
      {(Number(queue?.active || 0) > 0 || Number(queue?.queued || 0) > 0) && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--card)] p-3 text-xs text-[var(--muted-foreground)]">
          Login: {Number(queue?.active || 0)} running, {Number(queue?.queued || 0)} queued
        </div>
      )}

      {/* CodeBuddy farm banner */}
      {cbFarmStatus?.running && (
        <div className="rounded-md border border-[var(--primary)]/40 bg-[var(--primary)]/5 p-3 text-xs text-[var(--foreground)] space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <strong>CodeBuddy Farm</strong>
              <span className="text-[var(--muted-foreground)] ml-2">
                {cbFarmStatus.success}/{cbFarmStatus.target} ok
                {cbFarmStatus.failed > 0 ? ` · ${cbFarmStatus.failed} fail` : ""}
                {cbFarmStatus.concurrent > 0 ? ` · conc ${cbFarmStatus.concurrent}` : ""}
              </span>
            </div>
            <Button size="sm" variant="outline" onClick={handleCodeBuddyFarmStop} disabled={cbFarmBusy}>
              Stop
            </Button>
          </div>
          <Progress
            value={cbFarmStatus.target > 0 ? Math.round(((cbFarmStatus.success + cbFarmStatus.failed) / cbFarmStatus.target) * 100) : 0}
          />
          {cbFarmStatus.lastMessage && (
            <p className="text-[var(--muted-foreground)] break-all">{cbFarmStatus.lastMessage}</p>
          )}
        </div>
      )}

      {/* Grok farm banner — same surface as login queue */}
      {farmStatus?.running && (
        <div className="rounded-md border border-[var(--primary)]/40 bg-[var(--primary)]/5 p-3 text-xs text-[var(--foreground)] space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <strong>Grok Farm</strong>
              {" · "}
              {farmStatus.success}/{farmStatus.target} ok
              {farmStatus.failed > 0 ? ` · ${farmStatus.failed} fail` : ""}
              {farmStatus.concurrent > 0 ? ` · conc ${farmStatus.concurrent}` : ""}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => navigate("/bot-logs")}
            >
              Open Bot Logs
            </Button>
          </div>
          <Progress
            value={farmStatus.target > 0 ? Math.round(((farmStatus.success + farmStatus.failed) / farmStatus.target) * 100) : 0}
            className="h-2"
          />
          {farmStatus.lastMessage && (
            <p className="text-[var(--muted-foreground)] font-mono truncate">{farmStatus.lastMessage}</p>
          )}
        </div>
      )}

      {/* Provider cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {providerStats.map((stat) => (
          <Card
            key={stat.provider}
            className="border-[var(--border)] cursor-pointer hover:border-[var(--primary)]/50 transition-colors"
            onClick={() => navigate(`/accounts/${stat.provider}`)}
          >
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{labelProvider(stat.provider)}</CardTitle>
                <span className="text-xs text-[var(--muted-foreground)]">{stat.total} accounts</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Status grid */}
              <div className="grid grid-cols-4 gap-2 text-center">
                <div className="rounded-md bg-[var(--secondary)] p-2">
                  <p className="text-lg font-bold text-[var(--success)]">{stat.active}</p>
                  <p className="text-[10px] text-[var(--muted-foreground)]">Active</p>
                </div>
                <div className="rounded-md bg-[var(--secondary)] p-2">
                  <p className="text-lg font-bold text-[var(--warning)]">{stat.exhausted}</p>
                  <p className="text-[10px] text-[var(--muted-foreground)]">Exhausted</p>
                </div>
                <div className="rounded-md bg-[var(--secondary)] p-2">
                  <p className="text-lg font-bold text-[var(--warning)]">{stat.pending}</p>
                  <p className="text-[10px] text-[var(--muted-foreground)]">Pending</p>
                </div>
                <div className="rounded-md bg-[var(--secondary)] p-2">
                  <p className="text-lg font-bold text-[var(--error)]">{stat.error}</p>
                  <p className="text-[10px] text-[var(--muted-foreground)]">Error</p>
                </div>
              </div>

              {/* Credits remaining */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-[var(--muted-foreground)]">Credits</span>
                  <span className="text-[var(--foreground)]">
                    {stat.credits.remaining.toFixed(1)} / {stat.credits.total.toFixed(1)} remaining
                  </span>
                </div>
                <Progress
                  value={stat.credits.total > 0 ? Math.round((stat.credits.remaining / stat.credits.total) * 100) : 0}
                  className="h-2"
                />
              </div>

              {/* WarmUp progress - shown while warmup is active */}
              {warmupProgress[stat.provider] && warmupProgress[stat.provider].total > 0 && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-[var(--muted-foreground)]">WarmUp</span>
                    <span className="text-[var(--foreground)]">
                      {warmupProgress[stat.provider].completed} / {warmupProgress[stat.provider].total} completed
                    </span>
                  </div>
                  <Progress
                    value={warmupProgress[stat.provider].total > 0 ? Math.round((warmupProgress[stat.provider].completed / warmupProgress[stat.provider].total) * 100) : 0}
                    className="h-2"
                  />
                </div>
              )}

              {/* Grok farm progress on card */}
              {stat.provider === "grok" && farmStatus?.running && farmStatus.target > 0 && (
                <div className="space-y-1.5" onClick={(e) => e.stopPropagation()}>
                  <div className="flex justify-between text-xs">
                    <span className="text-[var(--muted-foreground)]">Farm</span>
                    <span className="text-[var(--foreground)]">
                      {farmStatus.success + farmStatus.failed} / {farmStatus.target}
                      {farmStatus.failed > 0 ? ` (${farmStatus.failed} fail)` : ""}
                    </span>
                  </div>
                  <Progress
                    value={Math.round(((farmStatus.success + farmStatus.failed) / farmStatus.target) * 100)}
                    className="h-2"
                  />
                </div>
              )}

              {/* Auto WarmUp toggle + countdown (not for github inventory) */}
              {stat.provider !== "github" && (
              <div
                className="flex items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--secondary)]/40 p-2"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Flame className={`h-4 w-4 shrink-0 ${autoWarmupEnabledFor(stat.provider) ? "text-[var(--warning)]" : "text-[var(--muted-foreground)]"}`} />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-[var(--foreground)] leading-tight">Auto WarmUp</p>
                    <p className="text-[10px] text-[var(--muted-foreground)] leading-tight">
                      {autoWarmupEnabledFor(stat.provider)
                        ? autoWarmup?.nextRunAt
                          ? `Next in ${countdownLabel()} · every ${autoWarmup.intervalMinutes}m`
                          : `Every ${autoWarmup?.intervalMinutes ?? 15}m`
                        : "Disabled"}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggleAutoWarmup(stat.provider)}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                    autoWarmupEnabledFor(stat.provider) ? "bg-[var(--primary)]" : "bg-[var(--border)]"
                  }`}
                  aria-label={`Toggle auto warmup for ${labelProvider(stat.provider)}`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      autoWarmupEnabledFor(stat.provider) ? "translate-x-5" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>
              )}

              {/* Buttons */}
              <div className="grid grid-cols-3 gap-2" onClick={(e) => e.stopPropagation()}>
                {stat.provider === "github" ? (
                  <>
                    <Button
                      className="w-full col-span-2"
                      variant="default"
                      size="sm"
                      onClick={() => handleExportGithub(false)}
                      title="Export email|username|country|sessid (no passwords)"
                    >
                      <Upload className="mr-1 h-4 w-4" /> Export
                    </Button>
                    <Button
                      className="w-full"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (confirm("Export GitHub inventory INCLUDING passwords? Keep the file private.")) {
                          handleExportGithub(true);
                        }
                      }}
                      title="Export with passwords"
                    >
                      <Key className="mr-1 h-4 w-4" /> +PW
                    </Button>
                  </>
                ) : (
                  <>
                    <Button className="w-full" variant="default" size="sm" onClick={() => handleOpenAddDialog(stat.provider)}>
                      <Plus className="mr-1 h-4 w-4" /> Add
                    </Button>
                    <Button className="w-full" variant="outline" size="sm" onClick={() => handleWarmupProvider(stat.provider)} disabled={Boolean(warmupProgress[stat.provider])}>
                      <RefreshCw className="mr-1 h-4 w-4" /> Warmup
                    </Button>
                    {stat.provider === "grok" ? (
                      <div className="col-span-3 grid grid-cols-2 gap-2">
                        <Button
                          className="w-full"
                          variant="outline"
                          size="sm"
                          onClick={() => handleGrokRefreshTokens()}
                          title="Force OAuth refresh_token (server bulk, max 50). Permanent invalid_grant is skipped/marked dead; missing-token accounts stay reauthable."
                        >
                          <RotateCcw className="mr-1 h-4 w-4" /> Refresh tok
                        </Button>
                        <Button
                          className="w-full"
                          variant="outline"
                          size="sm"
                          onClick={() => handleGrokReauthDead()}
                          disabled={stat.error === 0}
                          title="Re-login dead accounts with stored password (or GROK_PASSWORD). Farm = create new accounts; Reauth = revive existing. Needs real password (not grok-cli-token-auth placeholder)."
                        >
                          <RotateCcw className="mr-1 h-4 w-4" /> Reauth dead
                        </Button>
                      </div>
                    ) : (
                      <Button className="w-full" variant="outline" size="sm" onClick={() => handleRetryErrors(stat.provider)} disabled={stat.error === 0}>
                        <RotateCcw className="mr-1 h-4 w-4" /> Retry
                      </Button>
                    )}
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* BYOK Providers Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--primary)]/10 text-[var(--primary)]">
              <Key className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-[var(--foreground)]">Custom Providers (BYOK)</h2>
              <p className="text-sm text-[var(--muted-foreground)]">Bring Your Own Key — use your own API providers</p>
            </div>
          </div>
          <Button onClick={() => setByokDialogOpen(true)} className="gap-2 shadow-sm">
            <Plus className="h-4 w-4" /> Add Provider
          </Button>
        </div>

        {byokProviders.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--primary)]/20 bg-[var(--primary)]/[0.02] p-10 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--primary)]/10">
              <Shield className="h-7 w-7 text-[var(--primary)]" />
            </div>
            <p className="text-sm font-medium text-[var(--foreground)]">No custom providers configured yet</p>
            <p className="text-xs text-[var(--muted-foreground)] mt-1.5 mb-4">Connect your own API provider to use custom models with your keys</p>
            <Button size="sm" onClick={() => setByokDialogOpen(true)} className="gap-2">
              <Plus className="h-4 w-4" /> Add Your First Provider
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {byokProviders.map((provider) => (
              <Card
                key={provider.id}
                className="border-[var(--border)] overflow-hidden hover:border-[var(--primary)]/50 transition-all duration-200 cursor-pointer"
                onClick={() => navigate(`/accounts/byok/${provider.label}`)}
              >
                <CardHeader className="pb-3 hover:bg-[var(--secondary)]/30 transition-colors">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="text-base truncate">{provider.label}</CardTitle>
                        <Badge
                          variant={(provider.active_key_count || 0) > 0 ? "default" : "secondary"}
                          className={(provider.active_key_count || 0) > 0
                            ? "bg-[var(--primary)]/15 text-[var(--primary)] border border-[var(--primary)]/30"
                            : "bg-[var(--warning)]/10 text-[var(--warning)] border border-[var(--warning)]/30"
                          }
                        >
                          {(provider.active_key_count || 0) > 0 ? "● Ready" : "○ No active key"}
                        </Badge>
                      </div>
                      <p className="text-xs text-[var(--muted-foreground)] mt-1 truncate">{provider.base_url}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--muted-foreground)]">
                        <span className="rounded-full bg-[var(--secondary)] px-2 py-0.5">{provider.active_key_count ?? 0}/{provider.key_count ?? provider.keys?.length ?? 1} keys active</span>
                        <span className="rounded-full bg-[var(--secondary)] px-2 py-0.5">LB: {provider.load_balancing_method === "sequential" ? "Sequential" : provider.load_balancing_method === "least_inflight" ? "Least in-flight" : "Round robin"}</span>
                      </div>
                    </div>
                    <ChevronDown className="h-4 w-4 -rotate-90 text-[var(--muted-foreground)]" />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-[var(--muted-foreground)]">Format</span>
                      <span className="text-[var(--foreground)] font-medium">{provider.format}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-[var(--muted-foreground)]">Models</span>
                      <span className="text-[var(--foreground)] font-medium">{provider.models.length}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-[var(--muted-foreground)]">API Keys</span>
                      <span className="text-[var(--foreground)] font-medium">{provider.active_key_count ?? 0} active / {provider.key_count ?? provider.keys?.length ?? 1} total</span>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-xs text-[var(--muted-foreground)]">Available Models</p>
                    <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
                      {provider.available_models?.slice(0, 10).map((model) => (
                        <Badge
                          key={model}
                          variant="outline"
                          className="text-xs border-[var(--primary)]/20 text-[var(--primary)]/80 bg-[var(--primary)]/[0.05] font-mono cursor-copy"
                          onClick={(e) => { e.stopPropagation(); copyByokModel(model); }}
                          title="Click to copy model id"
                        >
                          {model}
                        </Badge>
                      ))}
                      {provider.available_models && provider.available_models.length > 10 && (
                        <Badge variant="outline" className="text-xs bg-[var(--primary)]/10 text-[var(--primary)] border-[var(--primary)]/30 font-medium">
                          +{provider.available_models.length - 10} more
                        </Badge>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 pt-3 border-t border-[var(--border)]/50">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-[var(--foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                      onClick={(e) => { e.stopPropagation(); navigate(`/accounts/byok/${provider.label}`); }}
                    >
                      <Pencil className="h-3.5 w-3.5" /> Manage
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 border-[var(--info)]/30 text-[var(--info)] hover:bg-[var(--info)]/10 hover:text-[var(--info)]"
                      onClick={(e) => { e.stopPropagation(); handleTestByok(provider.id, provider.label); }}
                    >
                      <Zap className="h-3.5 w-3.5" /> Test
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 border-[var(--error)]/30 text-[var(--error)] hover:bg-[var(--error)]/10 hover:text-[var(--error)]"
                      onClick={(e) => { e.stopPropagation(); handleDeleteByok(provider.id, provider.label); }}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* BYOK Add/Edit Dialog */}
      <Dialog open={byokDialogOpen} onOpenChange={(open) => !open && handleCloseByokDialog()}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--primary)]/10 text-[var(--primary)]">
                <Key className="h-4.5 w-4.5" />
              </div>
              <div>
                <DTitle>{byokEditId ? 'Edit Custom Provider' : 'Add Custom Provider'}</DTitle>
                <DialogDescription className="mt-0.5">
                  {byokEditId ? 'Update your AI provider configuration' : 'Configure your own AI provider with your API key'}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="space-y-4 pt-3">
            {/* Connection Settings */}
            <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--secondary)]/[0.06] p-3.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Connection</p>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-[var(--foreground)]">Provider Name</label>
                <Input
                  value={byokForm.label}
                  onChange={(e) => setByokForm({ ...byokForm, label: e.target.value })}
                  placeholder="e.g., openrouter, myprovider"
                  readOnly={byokEditId !== null}
                  className={`focus:ring-1 focus:ring-[var(--ring)] ${byokEditId ? 'bg-[var(--muted)] opacity-60' : ''}`}
                />
                <p className="text-xs text-[var(--muted-foreground)]">
                  {byokEditId ? 'Prefix cannot be changed after creation' : 'Used as model prefix (e.g., "openrouter-gpt-4")'}
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-[var(--foreground)]">Base URL</label>
                <Input
                  value={byokForm.base_url}
                  onChange={(e) => setByokForm({ ...byokForm, base_url: e.target.value })}
                  placeholder="https://api.provider.com/v1"
                  className="focus:ring-1 focus:ring-[var(--ring)]"
                />
              </div>
            </div>

            {/* Authentication */}
            <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--secondary)]/[0.06] p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
                  <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">API Key Pool</p>
                </div>
                <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={addByokKeyRow}>
                  <Plus className="h-3 w-3" /> Add Key
                </Button>
              </div>
              <p className="text-xs text-[var(--muted-foreground)]">
                Multiple keys under the same provider prefix are load-balanced automatically. Existing keys are masked; leave them masked to keep the stored secret.
              </p>

              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {byokForm.keys.map((keyRow, index) => (
                  <div key={`${keyRow.id || "new"}-${index}`} className="rounded-md border border-[var(--border)] bg-[var(--card)] p-2.5 space-y-2">
                    <div className="flex items-center gap-2">
                      <Input
                        value={keyRow.label}
                        onChange={(e) => updateByokKeyRow(index, { label: e.target.value })}
                        placeholder="key label e.g. main"
                        className="h-8 flex-1 font-mono text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => updateByokKeyRow(index, { enabled: !keyRow.enabled })}
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${keyRow.enabled ? "bg-[var(--primary)]" : "bg-[var(--border)]"}`}
                        title={keyRow.enabled ? "Enabled" : "Disabled"}
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${keyRow.enabled ? "translate-x-5" : "translate-x-1"}`} />
                      </button>
                      <Button type="button" variant="outline" size="sm" className="h-8 px-2 text-[var(--error)]" onClick={() => removeByokKeyRow(index)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="flex items-center gap-2">
                      {(() => {
                        const visibilityId = byokSecretVisibilityId(keyRow, index);
                        const secretVisible = visibleByokSecrets.has(visibilityId);
                        return (
                          <div className="flex flex-1 items-center gap-1">
                            <Input
                              type={secretVisible ? "text" : "password"}
                              value={keyRow.key}
                              onChange={(e) => updateByokKeyRow(index, { key: e.target.value })}
                              onFocus={() => {
                                if (keyRow.key === BYOK_KEY_PLACEHOLDER) updateByokKeyRow(index, { key: "" });
                              }}
                              placeholder={byokEditId ? "Paste new key to replace, or keep masked" : "sk-..."}
                              className="h-8 flex-1 font-mono text-xs"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 shrink-0"
                              onClick={() => toggleByokSecretVisibility(keyRow, index)}
                              disabled={revealingByokSecret === visibilityId}
                              title={secretVisible ? "Hide key" : "Show key"}
                            >
                              {revealingByokSecret === visibilityId ? <Loader2 className="h-4 w-4 animate-spin" /> : secretVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </Button>
                          </div>
                        );
                      })()}
                      {keyRow.status && (
                        <Badge variant="outline" className={keyRow.status === "active" && keyRow.enabled ? "border-[var(--success)]/30 text-[var(--success)]" : "border-[var(--warning)]/30 text-[var(--warning)]"}>
                          {keyRow.enabled ? keyRow.status : "disabled"}
                        </Badge>
                      )}
                    </div>
                    {keyRow.errorMessage && <p className="text-[10px] text-[var(--error)] truncate">{keyRow.errorMessage}</p>}
                  </div>
                ))}
              </div>
            </div>

            {/* Model Configuration */}
            <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--secondary)]/[0.06] p-3.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Configuration</p>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-[var(--foreground)]">API Format</label>
                  <select
                    value={byokForm.format}
                    onChange={(e) => setByokForm({ ...byokForm, format: e.target.value as any })}
                    className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                  >
                    <option value="auto">Auto-detect</option>
                    <option value="openai">OpenAI-compatible</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-[var(--foreground)]">Load Balancing</label>
                  <select
                    value={byokForm.load_balancing_method}
                    onChange={(e) => setByokForm({ ...byokForm, load_balancing_method: e.target.value as any })}
                    className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                  >
                    <option value="round_robin">Round Robin</option>
                    <option value="sequential">Sequential</option>
                  </select>
                  <p className="text-[10px] text-[var(--muted-foreground)]">
                    Per-provider BYOK setting. Round Robin distributes requests; Sequential prefers the first healthy key.
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-[var(--foreground)]">Models</label>
                <textarea
                  value={byokForm.models}
                  onChange={(e) => setByokForm({ ...byokForm, models: e.target.value })}
                  placeholder="gpt-4, claude-3-opus, llama-3"
                  className="w-full h-20 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                />
                <p className="text-xs text-[var(--muted-foreground)]">Comma-separated list of model IDs</p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={handleCloseByokDialog} className="text-[var(--muted-foreground)]">
                Cancel
              </Button>
              <Button onClick={byokEditId ? handleUpdateByok : handleAddByok} className="gap-2 shadow-sm">
                {byokEditId ? (
                  <><Pencil className="h-4 w-4" /> Update Provider</>
                ) : (
                  <><Plus className="h-4 w-4" /> Add Provider</>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Login Pending Dialog */}
      <Dialog open={loginPendingDialog} onOpenChange={setLoginPendingDialog}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DTitle>Login Pending Accounts</DTitle>
            <DialogDescription>Choose how many accounts to login concurrently.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="flex items-center gap-3">
              <label className="text-sm text-[var(--muted-foreground)]">Concurrent:</label>
              <select value={loginPendingConcurrency} onChange={(e) => setLoginPendingConcurrency(Number(e.target.value))} className="h-8 w-20 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)]">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setLoginPendingDialog(false)}>Cancel</Button>
              <Button size="sm" onClick={confirmLoginAll}>
                <Play className="w-4 h-4 mr-2" /> Start Login
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Account Dialog (per-provider) */}
      <Dialog open={addDialogProvider !== null} onOpenChange={(open) => {
        if (open) return;
        handleCloseAddDialog();
      }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DTitle>Add {addDialogProvider ? labelProvider(addDialogProvider) : ""} Account</DTitle>
            <DialogDescription>
              {addDialogProvider === "kiro-pro" || addDialogProvider === "codex"
                ? "Add via browser login or instant login with API key/token."
                : addDialogProvider === "qoder"
                ? "Add via PAT, bulk Google accounts, or single account."
                : addDialogProvider === "gitlab-duo"
                ? "Add via Personal Access Token, single Gmail (bot login), or bulk email|password."
                : addDialogProvider === "youmind"
                ? "Paste your YouMind API key (sk-ym-...). Server will validate against the OpenAPI relay and store it encrypted."
                : addDialogProvider === "codebuddy-china"
                ? "Paste CodeBuddy China API keys (ck_...). Satu key per baris untuk bulk import."
                : addDialogProvider === "codebuddy"
                ? "HTTP farm (iCloud HME → GitHub → mint ck_) or paste keys / session. Needs HME + DataDome solver + DataImpulse."
                : addDialogProvider === "grok"
                ? "HTTP farm (no browser) or paste CPA JSON import. Farm needs Boterdrop :8000 + tempmail; auto-imports to pool."
                : `Add account for ${addDialogProvider ? labelProvider(addDialogProvider) : "this provider"}.`}
            </DialogDescription>
          </DialogHeader>

          {/* Mode tabs */}
          {addDialogProvider === "kiro-pro" || addDialogProvider === "codex" ? (
            <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1">
              <button onClick={() => setAddMode("instant")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "instant" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Instant Login (Token)</button>
              {addDialogProvider === "codex" && <button onClick={() => handleSetCodexMode("pat")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "pat" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >OAuth Login</button>}
              <button onClick={() => addDialogProvider === "codex" ? handleSetCodexMode("bulk") : setAddMode("bulk")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "bulk" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Bulk (Email|Pass)</button>
              <button onClick={() => addDialogProvider === "codex" ? handleSetCodexMode("single") : setAddMode("single")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "single" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Single</button>
            </div>
          ) : addDialogProvider === "qoder" ? (
            <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1">
              <button onClick={() => setAddMode("pat")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "pat" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >PAT (Token)</button>
              <button onClick={() => setAddMode("bulk")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "bulk" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Bulk (Email|Pass)</button>
              <button onClick={() => setAddMode("single")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "single" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Single</button>
            </div>
          ) : addDialogProvider === "gitlab-duo" ? (
            <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1">
              <button onClick={() => setAddMode("pat")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "pat" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >PAT (Token)</button>
              <button onClick={() => setAddMode("single")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "single" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Gmail (Single)</button>
              <button onClick={() => setAddMode("bulk")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "bulk" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Bulk (Email|Pass)</button>
            </div>
          ) : addDialogProvider === "youmind" ? (
            <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1">
              <button onClick={() => setAddMode("pat")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "pat" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >API Key (sk-ym-...)</button>
            </div>
          ) : addDialogProvider === "grok" ? (
            <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1">
              <button onClick={() => setGrokMode("farm")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${grokMode === "farm" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Farm</button>
              <button onClick={() => setGrokMode("import")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${grokMode === "import" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Import JSON</button>
            </div>
          ) : addDialogProvider === "codebuddy-china" ? (
            <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1">
              <button onClick={() => setAddMode("apikey")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "apikey" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Bulk API Key (ck_...)</button>
            </div>
          ) : addDialogProvider === "codebuddy" ? (
            <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1 flex-wrap">
              <button onClick={() => setCodebuddyMode("farm")}
                className={`flex-1 min-w-[4.5rem] rounded px-3 py-1.5 text-xs font-medium transition-colors ${codebuddyMode === "farm" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Farm</button>
              <button onClick={() => { setCodebuddyMode("apikey"); setAddMode("apikey"); }}
                className={`flex-1 min-w-[4.5rem] rounded px-3 py-1.5 text-xs font-medium transition-colors ${codebuddyMode === "apikey" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >API Keys</button>
              <button onClick={() => { setCodebuddyMode("bulk"); setAddMode("bulk"); }}
                className={`flex-1 min-w-[4.5rem] rounded px-3 py-1.5 text-xs font-medium transition-colors ${codebuddyMode === "bulk" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Bulk</button>
              <button onClick={() => { setCodebuddyMode("single"); setAddMode("single"); }}
                className={`flex-1 min-w-[4.5rem] rounded px-3 py-1.5 text-xs font-medium transition-colors ${codebuddyMode === "single" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Single</button>
              <button onClick={() => { setCodebuddyMode("pat"); setAddMode("pat"); }}
                className={`flex-1 min-w-[4.5rem] rounded px-3 py-1.5 text-xs font-medium transition-colors ${codebuddyMode === "pat" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Session</button>
            </div>
          ) : (
            <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1">
              <button onClick={() => setAddMode("bulk")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "bulk" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Bulk (Email|Pass)</button>
              <button onClick={() => setAddMode("single")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "single" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Single</button>
            </div>
          )}

          {/* Token / OAuth mode */}
          {addMode === "pat" && addDialogProvider === "qoder" && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">Personal Access Token (PAT)</label>
                <textarea
                  value={cookieValue}
                  onChange={(e) => setCookieValue(e.target.value)}
                  className="mt-1 w-full h-40 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                  placeholder="qd-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Paste Qoder Personal Access Token. Server akan menukar dengan jobToken otomatis dan menyimpan kredensial untuk inference.</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleCookieLogin}>Add Account</Button>
              </div>
            </div>
          )}

          {addMode === "pat" && addDialogProvider === "youmind" && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">YouMind API Key</label>
                <textarea
                  value={youmindApiKey}
                  onChange={(e) => setYoumindApiKey(e.target.value)}
                  className="mt-1 w-full h-32 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                  placeholder="sk-ym-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  disabled={youmindBusy}
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  Paste your YouMind API key from{" "}
                  <a href="https://youmind.com" target="_blank" rel="noreferrer" className="underline">youmind.com</a>{" "}
                  Settings → API Keys. Server validates via <code>POST /openapi/v1/listBoards</code> and stores the key encrypted.
                  Available models: <code>ym-claude-opus-4.6/4.7/4.8</code>, <code>ym-claude-sonnet-4.6</code>, <code>ym-gpt-5.5</code>, <code>ym-gpt-4o</code>.
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)} disabled={youmindBusy}>Cancel</Button>
                <Button onClick={handleYouMindApiKeyLogin} disabled={youmindBusy}>
                  {youmindBusy ? "Validating..." : "Add Account"}
                </Button>
              </div>
            </div>
          )}

          {addDialogProvider === "grok" && grokMode === "farm" && (
            <div className="space-y-4">
              <div className="rounded-md border border-[var(--success)]/40 bg-[var(--success)]/10 p-3 text-xs text-[var(--foreground)] space-y-1">
                <div><strong>HTTP farm automation</strong> (no browser). Same observability as Login: progress goes to <strong>Bot Logs</strong>.</div>
                <div className="text-[var(--muted-foreground)]">Needs Boterdrop :8000 + tempmail. Each success auto-imports into the Grok pool.</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm text-[var(--foreground)]">Count</label>
                  <Input
                    type="number"
                    min={1}
                    max={1000}
                    value={farmCount}
                    onChange={(e) => setFarmCount(Number(e.target.value) || 1)}
                    className="mt-1"
                    disabled={farmBusy || farmStatus?.running}
                  />
                </div>
                <div>
                  <label className="text-sm text-[var(--foreground)]">Concurrent</label>
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    value={farmConcurrent}
                    onChange={(e) => setFarmConcurrent(Number(e.target.value) || 1)}
                    className="mt-1"
                    disabled={farmBusy || farmStatus?.running}
                  />
                </div>
              </div>
              {farmStatus && (farmStatus.running || farmStatus.target > 0) && (
                <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--secondary)]/40 p-3">
                  <div className="flex justify-between text-xs">
                    <span className="text-[var(--muted-foreground)]">
                      {farmStatus.running ? "Running" : "Last run"}
                    </span>
                    <span className="text-[var(--foreground)] font-medium">
                      {farmStatus.success} ok · {farmStatus.failed} fail · {farmStatus.target} target
                    </span>
                  </div>
                  <Progress
                    value={
                      farmStatus.target > 0
                        ? Math.round(((farmStatus.success + farmStatus.failed) / farmStatus.target) * 100)
                        : 0
                    }
                    className="h-2"
                  />
                  {farmStatus.lastMessage && (
                    <p className="text-xs font-mono text-[var(--muted-foreground)] break-all">{farmStatus.lastMessage}</p>
                  )}
                  {farmStatus.error && (
                    <p className="text-xs text-red-500 break-all">{farmStatus.error}</p>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)} disabled={farmBusy}>
                  Cancel
                </Button>
                {farmStatus?.running && (
                  <Button variant="outline" onClick={() => navigate("/bot-logs")}>
                    Bot Logs
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={handleGrokFarmStop}
                  disabled={farmBusy || !farmStatus?.running}
                >
                  Stop
                </Button>
                <Button onClick={handleGrokFarmStart} disabled={farmBusy || farmStatus?.running}>
                  {farmBusy || farmStatus?.running
                    ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {farmStatus?.running ? "Running..." : "Starting..."}</>)
                    : "Start Farm"}
                </Button>
              </div>
            </div>
          )}

          {addDialogProvider === "grok" && grokMode === "import" && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">CPA JSON</label>
                <textarea
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  className="mt-1 w-full h-48 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                  placeholder={`// flat (+ optional password for later Reauth)
{"email":"a@x.com","access_token":"...","refresh_token":"...","password":"secret"}

// nested harvest
{"email":"b@x.com","tokens":{"access_token":"...","refresh_token":"..."}}

// array or NDJSON lines also OK`}
                  disabled={grokCliBusy}
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  Accepts single object, JSON array, or NDJSON. Required: <code>email</code>, <code>access_token</code>, <code>refresh_token</code> (camelCase keys OK). Nested <code>tokens</code> harvest format supported. Optional <code>password</code> / <code>xai_password</code> is stored encrypted for <strong>Reauth</strong> (not shown in list API).
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)} disabled={grokCliBusy}>Cancel</Button>
                <Button onClick={handleGrokCliImport} disabled={grokCliBusy || !bulkText.trim()}>
                  {grokCliBusy ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Importing...</>) : "Import Accounts"}
                </Button>
              </div>
            </div>
          )}

          {addMode === "pat" && addDialogProvider === "gitlab-duo" && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">GitLab Base URL</label>
                <Input
                  value={gitlabBaseUrl}
                  onChange={(e) => setGitlabBaseUrl(e.target.value)}
                  placeholder="https://gitlab.com"
                  className="mt-1 font-mono text-sm"
                  disabled={gitlabBusy}
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Default <code>https://gitlab.com</code>. Ganti kalau pakai self-hosted GitLab.</p>
              </div>
              <div>
                <label className="text-sm text-[var(--foreground)]">Personal Access Token (PAT)</label>
                <textarea
                  value={gitlabPat}
                  onChange={(e) => setGitlabPat(e.target.value)}
                  className="mt-1 w-full h-28 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                  placeholder="glpat-xxxxxxxxxxxxxxxxxxxx"
                  disabled={gitlabBusy}
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  Butuh scope <code>api</code>. Buat di{" "}
                  <a
                    href={`${(gitlabBaseUrl || "https://gitlab.com").replace(/\/$/, "")}/-/user_settings/personal_access_tokens?scopes=api&name=poolprox3-duo`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline text-[var(--foreground)] hover:opacity-80"
                  >
                    User Settings → Access Tokens
                  </a>.
                </p>
              </div>
              <div>
                <label className="text-sm text-[var(--foreground)]">Label (opsional)</label>
                <Input
                  value={gitlabLabel}
                  onChange={(e) => setGitlabLabel(e.target.value)}
                  placeholder="default: GitLab username"
                  className="mt-1"
                  disabled={gitlabBusy}
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Kosongkan untuk pakai username GitLab. Harus unik per instance.</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)} disabled={gitlabBusy}>Cancel</Button>
                <Button onClick={handleGitlabPatLogin} disabled={gitlabBusy || !gitlabPat.trim()}>
                  {gitlabBusy ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Validating PAT...</>) : "Add Account"}
                </Button>
              </div>
            </div>
          )}

          {addDialogProvider === "codebuddy" && codebuddyMode === "farm" && (
            <div className="space-y-4">
              <div className="rounded-md border border-[var(--success)]/40 bg-[var(--success)]/10 p-3 text-xs text-[var(--foreground)] space-y-1">
                <div><strong>HTTP farm</strong> — iCloud HME → sticky GitHub → pure-HTTP OAuth → mint <code>ck_</code>.</div>
                <div className="text-[var(--muted-foreground)]">
                  Config: <strong>Settings → CodeBuddy Farm</strong> (preferred) or <code>scripts/codebuddy-farm/.env</code>.
                  Each GH account is saved to inventory provider <code>github</code>. Progress in <strong>Bot Logs</strong>.
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm text-[var(--foreground)]">Count</label>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={cbFarmCount}
                    onChange={(e) => setCbFarmCount(Number(e.target.value) || 1)}
                    className="mt-1"
                    disabled={cbFarmBusy || cbFarmStatus?.running}
                  />
                </div>
                <div>
                  <label className="text-sm text-[var(--foreground)]">Concurrent</label>
                  <Input
                    type="number"
                    min={1}
                    max={5}
                    value={cbFarmConcurrent}
                    onChange={(e) => setCbFarmConcurrent(Number(e.target.value) || 1)}
                    className="mt-1"
                    disabled={cbFarmBusy || cbFarmStatus?.running}
                  />
                  <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">Prefer 1 (sticky IP stability)</p>
                </div>
              </div>
              {cbFarmStatus && (
                <div className="rounded-md border border-[var(--border)] p-2 text-xs space-y-1">
                  <div>
                    Status: {cbFarmStatus.running ? "running" : "idle"} · {cbFarmStatus.success}/{cbFarmStatus.target} ok
                    {cbFarmStatus.failed ? ` · ${cbFarmStatus.failed} fail` : ""}
                  </div>
                  {cbFarmStatus.lastMessage && (
                    <p className="text-[var(--muted-foreground)] break-all">{cbFarmStatus.lastMessage}</p>
                  )}
                  {cbFarmStatus.error && (
                    <p className="text-xs text-red-500 break-all">{cbFarmStatus.error}</p>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)} disabled={cbFarmBusy}>
                  Cancel
                </Button>
                {cbFarmStatus?.running && (
                  <Button variant="outline" onClick={handleCodeBuddyFarmStop} disabled={cbFarmBusy}>
                    Stop
                  </Button>
                )}
                <Button onClick={handleCodeBuddyFarmStart} disabled={cbFarmBusy || cbFarmStatus?.running}>
                  {cbFarmBusy || cbFarmStatus?.running ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Running...</>
                  ) : (
                    "Start Farm"
                  )}
                </Button>
              </div>
            </div>
          )}

          {addMode === "apikey" && (addDialogProvider === "codebuddy-china" || (addDialogProvider === "codebuddy" && codebuddyMode === "apikey")) && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">API Keys (satu per baris, prefix ck_)</label>
                <textarea
                  value={codebuddyBulkApiKeys}
                  onChange={(e) => setCodebuddyBulkApiKeys(e.target.value)}
                  className="mt-1 w-full h-40 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                  placeholder="ck_fpigz68zr75s...
ck_abc123def456...
ck_xyz789ghi012..."
                  disabled={codebuddyApiKeyBusy}
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  {addDialogProvider === "codebuddy-china" ? (
                    <>
                      Paste satu atau lebih CodeBuddy China API key (prefix <code>ck_</code>), satu per baris.
                      Model tersedia: <code>cbc-deepseek-v3</code>, <code>cbc-claude-haiku-4.5</code>, <code>cbc-kimi-k2.5</code>, dll.
                    </>
                  ) : (
                    <>
                      Paste satu atau lebih CodeBuddy global API key (prefix <code>ck_</code>), satu per baris.
                      Catalog: CLI <code>/model</code> (Gemini/GPT-codex/DeepSeek/GLM/Kimi) + Claude haiku/sonnet/opus-4.6.
                      Untuk parity penuh dengan CLI login, pakai tab <strong>Session / JWT</strong>.
                    </>
                  )}
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)} disabled={codebuddyApiKeyBusy}>Cancel</Button>
                <Button
                  onClick={() => handleCodeBuddyBulkApiKey(addDialogProvider === "codebuddy" ? "codebuddy" : "codebuddy-china")}
                  disabled={codebuddyApiKeyBusy || !codebuddyBulkApiKeys.trim()}
                >
                  {codebuddyApiKeyBusy ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Importing...</>) : "Add Accounts"}
                </Button>
              </div>
            </div>
          )}

          {addMode === "pat" && addDialogProvider === "codebuddy" && codebuddyMode === "pat" && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">Session / JWT / auth.info JSON</label>
                <textarea
                  value={cookieValue}
                  onChange={(e) => setCookieValue(e.target.value)}
                  className="mt-1 w-full h-40 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                  placeholder={`// raw JWT access token
eyJhbGciOi...

// or CLI-style
{"auth":{"accessToken":"...","refreshToken":"..."},"account":{"email":"you@x.com","uid":"..."}}

// or
{"access_token":"...","refresh_token":"...","email":"you@x.com"}`}
                  disabled={codebuddyApiKeyBusy}
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  Import credential yang sama dengan CodeBuddy CLI (JWT session), bukan cuma <code>ck_</code>.
                  Optional email di field Single form dipakai sebagai label unik.
                </p>
              </div>
              <div>
                <label className="text-sm text-[var(--foreground)]">Label email (opsional)</label>
                <Input
                  value={addForm.email}
                  onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="you@x.com or leave blank for auto"
                  className="mt-1"
                  disabled={codebuddyApiKeyBusy}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)} disabled={codebuddyApiKeyBusy}>Cancel</Button>
                <Button onClick={handleCodeBuddySessionImport} disabled={codebuddyApiKeyBusy || !cookieValue.trim()}>
                  {codebuddyApiKeyBusy ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Importing...</>) : "Import Session"}
                </Button>
              </div>
            </div>
          )}

          {addMode === "pat" && addDialogProvider === "codex" && (
            <div className="space-y-3">
              <div className="rounded-md border border-[var(--border)] bg-[var(--secondary)]/30 p-3 text-sm text-[var(--muted-foreground)]">
                Login Codex bisa via popup OpenAI atau mode manual: generate auth URL, buka, lalu paste callback URL.
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button variant="outline" size="sm" onClick={handleCodexOAuthPrepareManual} disabled={codexOauthBusy || hasPreparedCodexOAuth}>
                  {hasPreparedCodexOAuth ? "Manual Ready" : codexOauthBusy ? "Preparing..." : "Prepare Manual"}
                </Button>
                <Button size="sm" onClick={handleCodexOAuthLogin} disabled={codexOauthBusy || hasPreparedCodexOAuth}>
                  {codexOauthBusy ? "Waiting for OAuth..." : "Start OAuth Login"}
                </Button>
              </div>

              {hasPreparedCodexOAuth && (
                <div className="space-y-3 rounded-md border border-[var(--border)] p-3">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-sm text-[var(--foreground)]">Auth URL</label>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={handleCodexOAuthCopyAuthUrl}>Copy</Button>
                        <Button size="sm" variant="outline" onClick={handleCodexOAuthOpenManual}>Open</Button>
                      </div>
                    </div>
                    <textarea
                      value={codexOauthAuthUrl}
                      readOnly
                      className="w-full h-20 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-xs font-mono text-[var(--foreground)] focus:outline-none resize-none"
                    />
                  </div>

                  <div className="rounded-md bg-[var(--secondary)]/30 p-3 text-xs text-[var(--muted-foreground)] space-y-1.5">
                    <p><span className="text-[var(--foreground)]">Callback:</span> <code className="break-all">{codexLoopbackUrl}</code></p>
                    <p><span className="text-[var(--foreground)]">Contoh:</span> <code className="break-all">{codexCallbackExample}</code></p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-sm text-[var(--foreground)]">Callback URL</label>
                      <Button size="sm" variant="outline" onClick={handleCodexOAuthPasteCallback} disabled={codexOauthBusy}>Paste</Button>
                    </div>
                    <textarea
                      value={codexOauthCallbackUrl}
                      onChange={(e) => setCodexOauthCallbackUrl(e.target.value)}
                      className="w-full h-20 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-xs font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                      placeholder={codexCallbackExample}
                    />
                    <div className="flex justify-end">
                      <Button size="sm" onClick={handleCodexOAuthSubmitManual} disabled={codexOauthBusy || !codexCallbackReady}>
                        {codexOauthBusy ? "Completing OAuth..." : "Submit Callback URL"}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={handleCloseAddDialog} disabled={codexOauthBusy && !hasPreparedCodexOAuth}>Cancel</Button>
              </div>
            </div>
          )}

          {/* Instant Login mode (Kiro Pro only) */}
          {addMode === "instant" && (addDialogProvider === "kiro-pro" || addDialogProvider === "codex") && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">Refresh Tokens (satu per baris)</label>
                <textarea
                  value={instantTokens}
                  onChange={(e) => setInstantTokens(e.target.value)}
                  className="mt-1 w-full h-40 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                  placeholder={"eyJhbGciOiJSUzI1NiIs...\neyJhbGciOiJSUzI1NiIs...\neyJhbGciOiJSUzI1NiIs..."}
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Paste refresh token per baris. Email otomatis di-extract dari token.</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleInstantLogin}>Login Instant</Button>
              </div>
            </div>
          )}

          {/* Bulk mode (all providers except Grok JSON import) */}
          {addMode === "bulk" && addDialogProvider !== "grok" && !(addDialogProvider === "codebuddy" && codebuddyMode === "farm") && (
            <div className="space-y-4">
              {addDialogProvider === "gitlab-duo" && (
                <div className="rounded-md border border-[var(--success)]/40 bg-[var(--success)]/10 p-3 text-xs text-[var(--foreground)] space-y-1">
                  <div><strong>Bot otomasi GitLab Duo aktif.</strong> Alurnya: Google OAuth → konfirmasi OTP via Gmail web → form Welcome → Free Trial Singapore → toggle Duo experiment → generate PAT (<code>poolprox3-duo</code>) → simpan ke akun.</div>
                  <div className="text-[var(--muted-foreground)]">⏱ Estimasi 4–6 menit per akun. <strong>Concurrency=1 disarankan</strong> agar Gmail tidak rate-limit. Pakai akun Gmail tanpa 2FA.</div>
                </div>
              )}
              <div>
                <label className="text-sm text-[var(--foreground)]">Accounts (email|password per baris)</label>
                <textarea
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  className="mt-1 w-full h-40 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                  placeholder={"email@example.com|password123\nanother@example.com|pass456"}
                />
              </div>
              <div>
                <label className="text-sm text-[var(--foreground)]">Browser Engine</label>
                <select value={bulkBrowserEngine} onChange={(e) => setBulkBrowserEngine(e.target.value)} className="mt-1 w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]">
                  <option value="camoufox">Camoufox (Anti-detect, default)</option>
                  <option value="chromium">Chromium (Playwright)</option>
                </select>
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
                  <input type="checkbox" checked={bulkHeadless} onChange={(e) => setBulkHeadless(e.target.checked)} className="h-4 w-4 rounded border-[var(--border)]" />
                  Run browser headless
                </label>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-[var(--foreground)]">Concurrent:</label>
                  <select value={bulkConcurrency} onChange={(e) => setBulkConcurrency(Number(e.target.value))} className="h-8 w-16 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)]">
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                    <option value={5}>5</option>
                    <option value={10}>10</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleBulkImport}>Import & Login</Button>
              </div>
            </div>
          )}

          {/* Single mode (all providers) */}
          {addMode === "single" && !(addDialogProvider === "codebuddy" && codebuddyMode === "farm") && (
            <div className="space-y-4">
              {addDialogProvider === "gitlab-duo" && (
                <div className="rounded-md border border-[var(--success)]/40 bg-[var(--success)]/10 p-3 text-xs text-[var(--foreground)] space-y-1">
                  <div><strong>Bot otomasi GitLab Duo aktif.</strong> Login Gmail di bawah lalu bot akan: Google OAuth → konfirmasi OTP via Gmail web → form Welcome → Free Trial Singapore → toggle Duo experiment → generate PAT.</div>
                  <div className="text-[var(--muted-foreground)]">⏱ Estimasi 4–6 menit. Pakai akun Gmail tanpa 2FA. Untuk batch banyak akun, gunakan tab <strong>Bulk</strong>.</div>
                </div>
              )}
              <div>
                <label className="text-sm text-[var(--foreground)]">Email</label>
                <Input value={addForm.email} onChange={(e) => setAddForm({ ...addForm, email: e.target.value })} placeholder="email@example.com" className="mt-1" />
              </div>
              <div>
                <label className="text-sm text-[var(--foreground)]">Password</label>
                <Input value={addForm.password} onChange={(e) => setAddForm({ ...addForm, password: e.target.value })} type="password" placeholder="********" className="mt-1" />
              </div>
              <div>
                <label className="text-sm text-[var(--foreground)]">Browser Engine</label>
                <select value={addForm.browserEngine} onChange={(e) => setAddForm({ ...addForm, browserEngine: e.target.value })} className="mt-1 w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]">
                  <option value="camoufox">Camoufox (Anti-detect, default)</option>
                  <option value="chromium">Chromium (Playwright)</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
                <input type="checkbox" checked={addForm.headless} onChange={(e) => setAddForm({ ...addForm, headless: e.target.checked })} className="h-4 w-4 rounded border-[var(--border)]" />
                Run browser headless
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleAdd}>Add Account</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
