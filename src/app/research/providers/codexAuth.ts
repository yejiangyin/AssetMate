import type { ResearchModelDefinition, ResearchThinkingLevel } from "../types";
import { updateResearchProviderApiKey } from "../storage";

// ChatGPT-subscription access through the same OAuth client and backend as the Codex CLI.
// None of this is a public OpenAI API; keep every Codex-specific constant in this file.
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CODEX_CLIENT_VERSION = "0.153.0";
export const CODEX_PERMISSION_ORIGINS = [
  "https://chatgpt.com/*",
  "https://auth.openai.com/*",
  "http://localhost/*",
  "http://127.0.0.1/*",
];
export const CODEX_DEFAULT_MODELS: ResearchModelDefinition[] = [{ id: "gpt-5.5", name: "GPT-5.5" }];
export const CODEX_CALLBACK_MESSAGE = "asset-helper:codex-oauth-callback";

const PENDING_KEY = "asset-helper:codex-oauth-pending:v1";
const CALLBACK_KEY = "asset-helper:codex-oauth-callback:v1";
const REFRESH_MARGIN_MS = 60_000;
const PENDING_TTL_MS = 15 * 60_000;
const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";

export interface CodexCredentials {
  type: "chatgpt_oauth";
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  accountId: string;
  email?: string;
  planType?: string;
}

interface CodexPendingLogin {
  profileId: string;
  state: string;
  verifier: string;
  startedAt: number;
}

export class CodexAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAuthError";
  }
}

type StorageArea = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

type ChromeLike = {
  storage?: {
    session?: StorageArea;
    onChanged?: {
      addListener: (listener: (changes: Record<string, unknown>, areaName: string) => void) => void;
      removeListener: (listener: (changes: Record<string, unknown>, areaName: string) => void) => void;
    };
  };
  permissions?: {
    contains: (permissions: { origins: string[] }) => Promise<boolean>;
    request: (permissions: { origins: string[] }) => Promise<boolean>;
  };
  tabs?: { create: (properties: { url: string; active?: boolean }) => Promise<unknown> };
  runtime?: {
    onMessage?: {
      addListener: (listener: (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => void) => void;
      removeListener: (listener: (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => void) => void;
    };
  };
};

function chromeApi(): ChromeLike | null {
  return (globalThis as typeof globalThis & { chrome?: ChromeLike }).chrome ?? null;
}

// chrome.storage.session survives the popup closing while the login tab is open;
// plain sessionStorage keeps the flow usable on the Vite dev server.
async function readTransient<T>(key: string): Promise<T | null> {
  const area = chromeApi()?.storage?.session;
  if (area) {
    try {
      return ((await area.get(key))[key] as T | undefined) ?? null;
    } catch {
      return null;
    }
  }
  try {
    const raw = globalThis.sessionStorage?.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

async function writeTransient(key: string, value: unknown) {
  const area = chromeApi()?.storage?.session;
  if (area) await area.set({ [key]: value });
  else globalThis.sessionStorage?.setItem(key, JSON.stringify(value));
}

async function removeTransient(key: string) {
  const area = chromeApi()?.storage?.session;
  if (area) await area.remove(key);
  else globalThis.sessionStorage?.removeItem(key);
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  const segment = token?.split(".")[1];
  if (!segment) return null;
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function claimRecord(payload: Record<string, unknown> | null, claim: string) {
  const value = payload?.[claim];
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function createCodexPkce() {
  const verifier = randomToken(64);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

export function buildCodexAuthorizeUrl({ challenge, state }: { challenge: string; state: string }) {
  const url = new URL(`${CODEX_ISSUER}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CODEX_CLIENT_ID);
  url.searchParams.set("redirect_uri", CODEX_REDIRECT_URI);
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("originator", "codex_cli_rs");
  return url.toString();
}

export function isCodexCallbackUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "1455" && url.pathname === "/auth/callback";
  } catch {
    return false;
  }
}

export function parseCodexCallbackUrl(value: string, expectedState: string) {
  if (!isCodexCallbackUrl(value)) throw new CodexAuthError("不是有效的登录回调地址 / Not a valid sign-in callback URL");
  const url = new URL(value.trim());
  const error = url.searchParams.get("error");
  if (error) throw new CodexAuthError(url.searchParams.get("error_description") || error);
  if (url.searchParams.get("state") !== expectedState) {
    throw new CodexAuthError("登录状态不匹配，请重新发起登录 / Sign-in state mismatch, please start again");
  }
  const code = url.searchParams.get("code");
  if (!code) throw new CodexAuthError("回调地址中缺少授权码 / Callback URL has no authorization code");
  return { code };
}

export function credentialsFromTokenResponse(payload: unknown, previous?: CodexCredentials): CodexCredentials {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const accessToken = stringValue(record.access_token);
  const refreshToken = stringValue(record.refresh_token) ?? previous?.refreshToken;
  if (!accessToken || !refreshToken) throw new CodexAuthError("登录服务未返回完整的令牌 / Sign-in did not return complete tokens");
  const idToken = stringValue(record.id_token) ?? previous?.idToken;
  const idClaims = decodeJwtPayload(idToken);
  const accessClaims = decodeJwtPayload(accessToken);
  const auth = claimRecord(idClaims, AUTH_CLAIM) ?? claimRecord(accessClaims, AUTH_CLAIM);
  const accountId = stringValue(auth?.chatgpt_account_id) ?? stringValue(record.account_id) ?? previous?.accountId;
  if (!accountId) throw new CodexAuthError("令牌中没有 ChatGPT 账号 ID / Token has no ChatGPT account ID");
  const expiresIn = Number(record.expires_in);
  const exp = Number(accessClaims?.exp);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? Date.now() + expiresIn * 1000
    : Number.isFinite(exp) && exp > 0 ? exp * 1000 : Date.now() + 3600_000;
  return {
    type: "chatgpt_oauth",
    accessToken,
    refreshToken,
    ...(idToken ? { idToken } : {}),
    expiresAt,
    accountId,
    email: stringValue(idClaims?.email) ?? stringValue(claimRecord(accessClaims, PROFILE_CLAIM)?.email) ?? previous?.email,
    planType: stringValue(auth?.chatgpt_plan_type) ?? previous?.planType,
  };
}

export function parseCodexCredentials(raw: string): CodexCredentials | null {
  if (!raw.trim().startsWith("{")) return null;
  try {
    const value = JSON.parse(raw) as Partial<CodexCredentials>;
    if (value.type !== "chatgpt_oauth" || !value.accessToken || !value.refreshToken || !value.accountId) return null;
    return { ...value, expiresAt: Number(value.expiresAt) || 0 } as CodexCredentials;
  } catch {
    return null;
  }
}

export function serializeCodexCredentials(credentials: CodexCredentials) {
  return JSON.stringify(credentials);
}

/** Accepts the contents of ~/.codex/auth.json written by `codex login`. */
export function importCodexAuthJson(text: string): CodexCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CodexAuthError("无法解析 auth.json 内容 / Could not parse auth.json");
  }
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const tokens = record.tokens && typeof record.tokens === "object" ? record.tokens as Record<string, unknown> : null;
  if (!tokens) throw new CodexAuthError("auth.json 中没有 ChatGPT 登录令牌 / auth.json has no ChatGPT tokens");
  const idToken = typeof tokens.id_token === "string"
    ? tokens.id_token
    : tokens.id_token && typeof tokens.id_token === "object"
      ? stringValue((tokens.id_token as Record<string, unknown>).raw_jwt)
      : undefined;
  return credentialsFromTokenResponse({ ...tokens, id_token: idToken, expires_in: undefined });
}

async function postToken(body: BodyInit, contentType: string) {
  let response: Response;
  try {
    response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });
  } catch {
    throw new CodexAuthError("无法连接 OpenAI 登录服务，请检查网络与域名权限 / Cannot reach OpenAI sign-in");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const error = record.error;
    const detail = stringValue(record.error_description)
      ?? (typeof error === "string" ? error : error && typeof error === "object" ? stringValue((error as Record<string, unknown>).message) : undefined);
    throw new CodexAuthError(detail || `OpenAI 登录服务返回 HTTP ${response.status}`);
  }
  return payload;
}

export async function exchangeCodexAuthorizationCode(code: string, verifier: string) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: CODEX_REDIRECT_URI,
    client_id: CODEX_CLIENT_ID,
    code_verifier: verifier,
  });
  return credentialsFromTokenResponse(await postToken(body.toString(), "application/x-www-form-urlencoded"));
}

export async function refreshCodexCredentials(credentials: CodexCredentials) {
  const payload = await postToken(JSON.stringify({
    client_id: CODEX_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
    scope: "openid profile email",
  }), "application/json");
  return credentialsFromTokenResponse(payload, credentials);
}

/** Must be the first await inside a click handler so Chrome treats it as a user gesture. */
export async function requestCodexPermissions() {
  const permissions = chromeApi()?.permissions;
  if (!permissions) return true;
  const origins = CODEX_PERMISSION_ORIGINS;
  if (await permissions.contains({ origins })) return true;
  return permissions.request({ origins });
}

export async function startCodexBrowserLogin(profileId: string) {
  const { verifier, challenge } = await createCodexPkce();
  const state = randomToken(24);
  await removeTransient(CALLBACK_KEY);
  await writeTransient(PENDING_KEY, { profileId, state, verifier, startedAt: Date.now() } satisfies CodexPendingLogin);
  const url = buildCodexAuthorizeUrl({ challenge, state });
  const tabs = chromeApi()?.tabs;
  if (tabs?.create) await tabs.create({ url, active: true });
  else globalThis.open?.(url, "_blank", "noopener");
}

export async function readCodexPendingLogin() {
  const pending = await readTransient<CodexPendingLogin>(PENDING_KEY);
  if (!pending) return null;
  if (Date.now() - pending.startedAt > PENDING_TTL_MS) {
    await removeTransient(PENDING_KEY);
    return null;
  }
  return { profileId: pending.profileId, startedAt: pending.startedAt };
}

export async function cancelCodexLogin() {
  await removeTransient(PENDING_KEY);
  await removeTransient(CALLBACK_KEY);
}

export async function completeCodexLoginFromUrl(callbackUrl: string) {
  const pending = await readTransient<CodexPendingLogin>(PENDING_KEY);
  if (!pending || Date.now() - pending.startedAt > PENDING_TTL_MS) {
    throw new CodexAuthError("登录已过期，请重新点击登录 / Sign-in expired, please start again");
  }
  const { code } = parseCodexCallbackUrl(callbackUrl, pending.state);
  // Clear first so a second open view cannot redeem the same one-time code.
  await cancelCodexLogin();
  const credentials = await exchangeCodexAuthorizationCode(code, pending.verifier);
  return { profileId: pending.profileId, credentials };
}

/** Redeems a callback the background worker captured from the login tab, if any. */
export async function consumeCodexCallback() {
  const callback = await readTransient<{ url: string }>(CALLBACK_KEY);
  if (!callback?.url) return null;
  await removeTransient(CALLBACK_KEY);
  return completeCodexLoginFromUrl(callback.url);
}

export function subscribeCodexCallback(listener: () => void) {
  const chrome = chromeApi();
  const onMessage = (message: unknown, _sender: unknown, sendResponse: (response?: unknown) => void) => {
    if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== CODEX_CALLBACK_MESSAGE) return;
    sendResponse({ handled: true });
    listener();
  };
  chrome?.runtime?.onMessage?.addListener(onMessage);
  return () => chrome?.runtime?.onMessage?.removeListener(onMessage);
}

const refreshes = new Map<string, Promise<CodexCredentials>>();
// Provider instances hold settings snapshots; after a rotation the newest tokens live here.
const latestCredentials = new Map<string, CodexCredentials>();

/**
 * Returns usable credentials for a profile, refreshing shortly before expiry. Refreshes are
 * serialized per profile because the refresh token rotates and may only be redeemed once.
 */
export async function ensureFreshCodexCredentials(profileId: string, raw: string, force = false) {
  const parsed = parseCodexCredentials(raw);
  if (!parsed) throw new CodexAuthError("请先登录 ChatGPT 账号 / Sign in to ChatGPT first");
  const cached = latestCredentials.get(profileId);
  const credentials = cached && cached.accountId === parsed.accountId && cached.expiresAt > parsed.expiresAt ? cached : parsed;
  if (!force && credentials.expiresAt - Date.now() > REFRESH_MARGIN_MS) return credentials;
  const running = refreshes.get(profileId);
  if (running) return running;
  const task = refreshCodexCredentials(credentials)
    .then(async (next) => {
      latestCredentials.set(profileId, next);
      await updateResearchProviderApiKey(profileId, serializeCodexCredentials(next)).catch(() => undefined);
      return next;
    })
    .finally(() => refreshes.delete(profileId));
  refreshes.set(profileId, task);
  return task;
}

export function codexRequestHeaders(credentials: CodexCredentials, stream: boolean): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    Authorization: `Bearer ${credentials.accessToken}`,
    "chatgpt-account-id": credentials.accountId,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    session_id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : randomToken(16),
  };
}

export function codexModelsEndpoint(endpoint: string) {
  const url = new URL(endpoint.trim());
  url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/(responses|models)$/, "")}/models`;
  url.search = "";
  url.searchParams.set("client_version", CODEX_CLIENT_VERSION);
  return url.toString();
}

const EFFORTS: ResearchThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function effortValue(value: unknown): ResearchThinkingLevel | undefined {
  const effort = value === "none" ? "off" : value;
  return EFFORTS.includes(effort as ResearchThinkingLevel) ? effort as ResearchThinkingLevel : undefined;
}

export function codexModelsFromPayload(payload: unknown): ResearchModelDefinition[] {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const items = Array.isArray(record.models) ? record.models : Array.isArray(record.data) ? record.data : [];
  return items.flatMap((item): ResearchModelDefinition[] => {
    if (!item || typeof item !== "object") return [];
    const model = item as Record<string, unknown>;
    if (model.visibility === "hide") return [];
    const id = stringValue(model.slug) ?? stringValue(model.id);
    if (!id) return [];
    const supportedEfforts = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels.flatMap((level) => {
        const effort = effortValue(level && typeof level === "object" ? (level as Record<string, unknown>).effort : level);
        return effort ? [effort] : [];
      })
      : [];
    const defaultEffort = effortValue(model.default_reasoning_level);
    return [{
      id,
      name: stringValue(model.display_name) ?? id,
      ...(supportedEfforts.length || defaultEffort ? { reasoning: { supportedEfforts, defaultEffort } } : {}),
    }];
  });
}
