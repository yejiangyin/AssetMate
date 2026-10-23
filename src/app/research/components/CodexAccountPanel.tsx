import { ClipboardPaste, FileJson, Loader2, LogIn, LogOut, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  cancelCodexLogin,
  completeCodexLoginFromUrl,
  importCodexAuthJson,
  parseCodexCredentials,
  readCodexPendingLogin,
  requestCodexPermissions,
  startCodexBrowserLogin,
  type CodexCredentials,
} from "../providers/codexAuth";
import { CONTROL_CLASS, Feedback, StatusPill } from "./settingsUi";

type Fallback = "none" | "callback" | "authJson";

function planLabel(plan: string | undefined) {
  if (!plan) return "";
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

export function CodexAccountPanel({
  profileId,
  apiKey,
  isEn,
  onBeforeLogin,
  onSignedIn,
  onSignOut,
}: {
  profileId: string;
  apiKey: string;
  isEn: boolean;
  /** Persists the connection so the login can finish even if the popup closes. */
  onBeforeLogin: () => Promise<void>;
  onSignedIn: (credentials: CodexCredentials) => void;
  onSignOut: () => void;
}) {
  const credentials = parseCodexCredentials(apiKey);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fallback, setFallback] = useState<Fallback>("none");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void readCodexPendingLogin().then((pending) => {
      if (!cancelled) setWaiting(pending?.profileId === profileId && !credentials);
    });
    return () => { cancelled = true; };
    // Re-check after a login lands (apiKey changes) as well as on mount.
  }, [profileId, apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const startLogin = async () => {
    setError("");
    // The permission prompt must be the first await so Chrome still sees the click.
    const granted = await requestCodexPermissions();
    if (!granted) {
      setError(isEn ? "Access to chatgpt.com and auth.openai.com is required to sign in." : "需要授权访问 chatgpt.com 与 auth.openai.com 才能登录。");
      return;
    }
    setBusy(true);
    try {
      await onBeforeLogin();
      await startCodexBrowserLogin(profileId);
      setWaiting(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    await cancelCodexLogin();
    setWaiting(false);
    setFallback("none");
  };

  const submitFallback = async () => {
    setError("");
    setBusy(true);
    try {
      if (fallback === "authJson") {
        const imported = importCodexAuthJson(input);
        const granted = await requestCodexPermissions();
        if (!granted) throw new Error(isEn ? "Access to chatgpt.com is required." : "需要授权访问 chatgpt.com。");
        onSignedIn(imported);
      } else {
        const result = await completeCodexLoginFromUrl(input);
        onSignedIn(result.credentials);
      }
      setInput("");
      setFallback("none");
      setWaiting(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (credentials) {
    const expiresIn = credentials.expiresAt - Date.now();
    return (
      <div className="space-y-2.5">
        <div className="flex items-center gap-2.5 rounded-xl border border-[rgba(16,163,127,0.25)] bg-[rgba(16,163,127,0.06)] px-2.5 py-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#10A37F] text-[12px] font-bold text-white">
            {(credentials.email ?? "C").charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="truncate text-[12px] font-semibold text-tp">{credentials.email ?? (isEn ? "ChatGPT account" : "ChatGPT 账号")}</p>
              {credentials.planType && <StatusPill tone="ok">{planLabel(credentials.planType)}</StatusPill>}
            </div>
            <p className="mt-0.5 truncate text-[11px] leading-4 text-tmi">
              {expiresIn > 0
                ? (isEn ? `Signed in · token renews automatically` : "已登录 · 令牌到期前自动续期")
                : (isEn ? "Token expired · renews on next request" : "令牌已过期 · 下次请求时自动续期")}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => void startLogin()} disabled={busy} className="flex h-8 items-center justify-center gap-1.5 rounded-lg border border-app-border bg-app-surface text-[11px] font-semibold text-ts disabled:opacity-50">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}{isEn ? "Switch account" : "重新登录"}
          </button>
          <button type="button" onClick={onSignOut} className="flex h-8 items-center justify-center gap-1.5 rounded-lg border border-app-border bg-app-surface text-[11px] font-semibold text-[#E04848]">
            <LogOut size={12} />{isEn ? "Sign out" : "退出登录"}
          </button>
        </div>
        <Feedback type="error" message={error} />
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {waiting ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-app-border bg-app-surface px-2.5 py-2.5">
          <Loader2 size={16} className="shrink-0 animate-spin text-[#10A37F]" />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold text-tp">{isEn ? "Waiting for ChatGPT sign-in…" : "等待 ChatGPT 登录…"}</p>
            <p className="mt-0.5 text-[11px] leading-4 text-tmi">
              {isEn
                ? "Finish signing in on the new tab. It closes and returns here automatically."
                : "请在新打开的标签页完成登录，完成后会自动关闭并回到这里。"}
            </p>
          </div>
          <button type="button" onClick={() => void cancel()} aria-label={isEn ? "Cancel sign-in" : "取消登录"} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-tmi"><X size={14} /></button>
        </div>
      ) : (
        <button type="button" onClick={() => void startLogin()} disabled={busy} className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[#10A37F] text-[12px] font-semibold text-white disabled:opacity-60">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
          {isEn ? "Sign in with ChatGPT" : "使用 ChatGPT 账号登录"}
        </button>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 text-[11px]">
        <span className="text-tmi">{isEn ? "Didn't return automatically?" : "没有自动返回？"}</span>
        <button type="button" onClick={() => setFallback(fallback === "callback" ? "none" : "callback")} className="flex items-center gap-1 text-[11px] font-medium leading-4 text-app-accent">
          <ClipboardPaste size={11} />{isEn ? "Paste callback URL" : "粘贴回调地址"}
        </button>
        <button type="button" onClick={() => setFallback(fallback === "authJson" ? "none" : "authJson")} className="flex items-center gap-1 text-[11px] font-medium leading-4 text-app-accent">
          <FileJson size={11} />{isEn ? "Import Codex CLI auth.json" : "导入 Codex CLI 登录"}
        </button>
      </div>

      {fallback !== "none" && (
        <div className="space-y-2 rounded-xl border border-app-border bg-app-surface p-2.5">
          <p className="text-[11px] leading-4 text-tm">
            {fallback === "callback"
              ? (isEn
                ? "After signing in, the tab lands on a localhost:1455 page that fails to load. Copy that full address and paste it here."
                : "登录后标签页会跳到一个无法打开的 localhost:1455 页面，复制该页面的完整地址粘贴到这里。")
              : (isEn
                ? "If you already use the Codex CLI, paste the contents of ~/.codex/auth.json. The session is copied, not shared, so signing out of either side does not affect the other."
                : "如果本机已登录 Codex CLI，可粘贴 ~/.codex/auth.json 的内容。会复制一份登录状态，双方各自续期、互不影响。")}
          </p>
          {fallback === "callback" ? (
            <input aria-label={isEn ? "Callback URL" : "回调地址"} className={CONTROL_CLASS} value={input} onChange={(event) => setInput(event.target.value)} placeholder="http://localhost:1455/auth/callback?code=…" spellCheck={false} autoComplete="off" />
          ) : (
            <textarea aria-label="auth.json" className={`${CONTROL_CLASS} h-20 resize-none font-mono text-[11px]`} value={input} onChange={(event) => setInput(event.target.value)} placeholder='{"tokens": {"access_token": "…", "refresh_token": "…"}}' spellCheck={false} autoComplete="off" />
          )}
          <button type="button" onClick={() => void submitFallback()} disabled={busy || !input.trim()} className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-app-accent text-[11px] font-semibold text-white disabled:opacity-50">
            {busy && <Loader2 size={12} className="animate-spin" />}{isEn ? "Finish sign-in" : "完成登录"}
          </button>
        </div>
      )}
      <Feedback type="error" message={error} />
    </div>
  );
}
