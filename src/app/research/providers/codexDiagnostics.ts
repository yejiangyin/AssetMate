import {
  CODEX_ISSUER,
  codexModelsEndpoint,
  codexModelsFromPayload,
  codexRequestHeaders,
  ensureFreshCodexCredentials,
  parseCodexCredentials,
  resolveCodexClientVersion,
} from "./codexAuth";
import { resolveResearchEndpoint } from "./openAiCompatible";

// Step-by-step check of the browser's path to the ChatGPT (Codex) backend, so a failure can be
// pinned to permissions, the network path, sign-in, /models or /responses. The report holds only
// statuses, timings, header names and event names: never tokens, prompts or account content.

export type CodexDiagnosticStatus = "ok" | "warn" | "fail" | "skip";

export interface CodexDiagnosticStep {
  id: "permissions" | "reach_chatgpt" | "reach_auth" | "credentials" | "models" | "responses";
  label: string;
  status: CodexDiagnosticStatus;
  detail: string;
  ms?: number;
}

export interface CodexDiagnosticInput {
  profileId: string;
  apiKey: string;
  endpoint: string;
  model: string;
  /** Test hook; defaults to the production deadlines. */
  timeoutsMs?: Partial<Record<"reach" | "models" | "responses", number>>;
}

const REACH_TIMEOUT_MS = 10_000;
const MODELS_TIMEOUT_MS = 15_000;
const RESPONSES_TIMEOUT_MS = 30_000;

type ChromeDiagnosticsApi = {
  permissions?: { contains: (permissions: { origins: string[] }) => Promise<boolean> };
  runtime?: { getManifest?: () => { version?: string } };
};

function chromeApi() {
  return (globalThis as typeof globalThis & { chrome?: ChromeDiagnosticsApi }).chrome ?? null;
}

class StepTimeout extends Error {}

/** Runs one network step with a hard deadline, even if the transport ignores the abort. */
async function timed<T>(ms: number, run: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = globalThis.setTimeout(() => {
      controller.abort();
      reject(new StepTimeout());
    }, ms);
  });
  try {
    const value = await Promise.race([run(controller.signal), deadline]);
    return { value, ms: Date.now() - started };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function describeError(error: unknown, timeoutMs: number) {
  if (error instanceof StepTimeout) return `${timeoutMs / 1000} 秒内没有响应（连接或响应头一直未返回）`;
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TypeError) return `网络层失败（${message}）：浏览器未能建立连接，尚未收到任何 HTTP 状态`;
  return `${name}: ${message}`.slice(0, 200);
}

/** Response facts that identify blocks and challenges without exposing the body. */
function responseFacts(response: Response) {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "no content-type";
  const mitigated = response.headers.get("cf-mitigated");
  return `HTTP ${response.status} · ${contentType}${mitigated ? ` · cf-mitigated: ${mitigated}` : ""}`;
}

async function errorDetail(response: Response) {
  const text = await response.text().catch(() => "");
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const error = payload.error;
    const detail = typeof payload.detail === "string" ? payload.detail
      : typeof error === "string" ? error
        : error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string" ? (error as { message: string }).message
          : "";
    return detail.slice(0, 160);
  } catch {
    return /<html/i.test(text) ? "返回了 HTML 页面（可能是拦截或验证页）" : "";
  }
}

export async function runCodexDiagnostics(
  input: CodexDiagnosticInput,
  onStep?: (steps: CodexDiagnosticStep[]) => void,
): Promise<CodexDiagnosticStep[]> {
  const steps: CodexDiagnosticStep[] = [];
  const push = (step: CodexDiagnosticStep) => {
    steps.push(step);
    onStep?.([...steps]);
  };
  const endpoint = input.endpoint.trim() || "https://chatgpt.com/backend-api/codex";
  const reachTimeout = input.timeoutsMs?.reach ?? REACH_TIMEOUT_MS;
  const modelsTimeout = input.timeoutsMs?.models ?? MODELS_TIMEOUT_MS;
  const responsesTimeout = input.timeoutsMs?.responses ?? RESPONSES_TIMEOUT_MS;
  const chatgptOrigin = new URL(endpoint).origin;

  const permissions = chromeApi()?.permissions;
  if (!permissions) {
    push({ id: "permissions", label: "域名权限", status: "skip", detail: "非扩展环境（开发服务器），不检查扩展权限" });
  } else {
    const origins = [`${chatgptOrigin}/*`, `${CODEX_ISSUER}/*`];
    const missing: string[] = [];
    for (const origin of origins) if (!await permissions.contains({ origins: [origin] }).catch(() => false)) missing.push(origin);
    push(missing.length
      ? { id: "permissions", label: "域名权限", status: "fail", detail: `未授权：${missing.join("、")}；请重新点击登录以授予访问权限` }
      : { id: "permissions", label: "域名权限", status: "ok", detail: "chatgpt.com 与 auth.openai.com 已授权" });
  }

  // Without credentials the backend should answer 401 quickly: that proves the network path.
  let chatgptReachable = false;
  try {
    const { value: response, ms } = await timed(reachTimeout, (signal) => fetch(codexModelsEndpoint(endpoint), { cache: "no-store", credentials: "omit", signal }));
    const facts = responseFacts(response);
    void response.body?.cancel().catch(() => undefined);
    chatgptReachable = true;
    const blocked = Boolean(response.headers.get("cf-mitigated")) || response.status === 403;
    push({
      id: "reach_chatgpt",
      label: "连接 chatgpt.com",
      status: blocked ? "warn" : "ok",
      detail: blocked ? `${facts}；可达，但未登录请求被拦截或要求验证` : `${facts}；网络可达（未带登录时返回 401 属正常）`,
      ms,
    });
  } catch (error) {
    push({ id: "reach_chatgpt", label: "连接 chatgpt.com", status: "fail", detail: `${describeError(error, reachTimeout)}；请检查代理/VPN 是否对 Chrome 生效` });
  }

  try {
    const { value: response, ms } = await timed(reachTimeout, (signal) => fetch(`${CODEX_ISSUER}/.well-known/openid-configuration`, { cache: "no-store", credentials: "omit", signal }));
    const facts = responseFacts(response);
    void response.body?.cancel().catch(() => undefined);
    push({ id: "reach_auth", label: "连接 auth.openai.com", status: response.ok ? "ok" : "warn", detail: `${facts}${response.ok ? "；登录服务可达" : ""}`, ms });
  } catch (error) {
    push({ id: "reach_auth", label: "连接 auth.openai.com", status: "fail", detail: `${describeError(error, reachTimeout)}；登录续期会失败` });
  }

  const parsed = parseCodexCredentials(input.apiKey);
  let credentials = parsed;
  if (!parsed) {
    push({ id: "credentials", label: "登录凭据", status: "fail", detail: "当前连接未登录 ChatGPT" });
  } else {
    const minutesLeft = Math.round((parsed.expiresAt - Date.now()) / 60_000);
    try {
      const { value, ms } = await timed(20_000, () => ensureFreshCodexCredentials(input.profileId, input.apiKey));
      credentials = value;
      const renewed = value.accessToken !== parsed.accessToken;
      push({
        id: "credentials",
        label: "登录凭据",
        status: "ok",
        detail: renewed ? "令牌已过期，已成功续期" : `令牌有效，约 ${Math.max(0, minutesLeft)} 分钟后到期（到期前自动续期）`,
        ms,
      });
    } catch (error) {
      credentials = null;
      push({ id: "credentials", label: "登录凭据", status: "fail", detail: `续期失败：${describeError(error, 20_000)}；请重新登录` });
    }
  }

  const skipNetwork = !chatgptReachable ? "chatgpt.com 网络不可达，已跳过" : !credentials ? "没有可用的登录凭据，已跳过" : "";
  if (skipNetwork || !credentials) {
    push({ id: "models", label: "获取模型（带登录）", status: "skip", detail: skipNetwork });
    push({ id: "responses", label: "最小对话请求", status: "skip", detail: skipNetwork });
    return steps;
  }
  const signedIn = credentials;

  try {
    const version = await resolveCodexClientVersion();
    const { value: result, ms } = await timed(modelsTimeout, async (signal) => {
      const response = await fetch(codexModelsEndpoint(endpoint, version), { cache: "no-store", headers: codexRequestHeaders(signedIn, false), signal });
      if (!response.ok) return { ok: false as const, facts: responseFacts(response), detail: await errorDetail(response) };
      const models = codexModelsFromPayload(await response.json().catch(() => null));
      return { ok: true as const, facts: responseFacts(response), count: models.length };
    });
    push(result.ok
      ? { id: "models", label: "获取模型（带登录）", status: result.count ? "ok" : "warn", detail: `${result.facts} · ${result.count} 个可用模型 · client_version ${version}`, ms }
      : { id: "models", label: "获取模型（带登录）", status: "fail", detail: `${result.facts}${result.detail ? `：${result.detail}` : ""}`, ms });
  } catch (error) {
    push({ id: "models", label: "获取模型（带登录）", status: "fail", detail: describeError(error, modelsTimeout) });
  }

  if (!input.model.trim()) {
    push({ id: "responses", label: "最小对话请求", status: "skip", detail: "未选择研究模型" });
    return steps;
  }
  const started = Date.now();
  const progress = { headersMs: 0, firstByteMs: 0, bytes: 0, events: 0, lastEvent: "", text: "", facts: "" };
  try {
    await timed(responsesTimeout, async (signal) => {
      const response = await fetch(resolveResearchEndpoint(endpoint, "responses", input.model, true, "openai_codex"), {
        method: "POST",
        cache: "no-store",
        headers: codexRequestHeaders(signedIn, true),
        body: JSON.stringify({
          model: input.model,
          stream: true,
          instructions: "You are a connection check.",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Reply with OK only." }] }],
          store: false,
        }),
        signal,
      });
      progress.headersMs = Date.now() - started;
      progress.facts = responseFacts(response);
      if (!response.ok) {
        progress.text = await errorDetail(response);
        return;
      }
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (value?.byteLength && !progress.firstByteMs) progress.firstByteMs = Date.now() - started;
          progress.bytes += value?.byteLength ?? 0;
          buffer += decoder.decode(value, { stream: !done });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() ?? "";
          let finished = false;
          for (const line of blocks.flatMap((block) => block.split(/\r?\n/)).filter((item) => item.startsWith("data:"))) {
            try {
              const payload = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
              progress.events += 1;
              if (typeof payload.type === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(payload.type)) progress.lastEvent = payload.type;
              if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") progress.text += payload.delta;
              if (payload.type === "response.completed" || payload.type === "response.failed" || payload.type === "response.incomplete") finished = true;
            } catch {
              // Ignore keep-alive comments and partial lines.
            }
          }
          if (finished || done) break;
        }
      } finally {
        void reader.cancel().catch(() => undefined);
      }
    });
    const ms = Date.now() - started;
    const ok = progress.facts.startsWith("HTTP 200") && /\bok\b/i.test(progress.text);
    const timing = `响应头 ${progress.headersMs}ms · 首字节 ${progress.firstByteMs || "-"}ms · ${progress.bytes} 字节 · ${progress.events} 个事件${progress.lastEvent ? ` · 最后事件 ${progress.lastEvent}` : ""}`;
    push({
      id: "responses",
      label: "最小对话请求",
      status: ok ? "ok" : "fail",
      detail: ok
        ? `${progress.facts} · ${timing} · 收到回答`
        : `${progress.facts}${progress.text && !progress.facts.startsWith("HTTP 200") ? `：${progress.text}` : ""} · ${timing}${progress.facts.startsWith("HTTP 200") ? " · 未收到回答文本" : ""}`,
      ms,
    });
  } catch (error) {
    const stage = !progress.headersMs ? "等待响应头" : !progress.firstByteMs ? `已收到响应头（${progress.headersMs}ms · ${progress.facts}），等待首字节` : `已收到 ${progress.bytes} 字节、${progress.events} 个事件${progress.lastEvent ? `（最后 ${progress.lastEvent}）` : ""}，等待结束事件`;
    push({ id: "responses", label: "最小对话请求", status: "fail", detail: `${describeError(error, responsesTimeout)} · 卡在：${stage}`, ms: Date.now() - started });
  }
  return steps;
}

const STATUS_MARK: Record<CodexDiagnosticStatus, string> = { ok: "✓", warn: "⚠", fail: "✗", skip: "–" };

/** Plain-text report the user can paste; contains no credentials or content. */
export function formatCodexDiagnostics(steps: CodexDiagnosticStep[], model: string) {
  const version = chromeApi()?.runtime?.getManifest?.().version ?? "dev";
  const browser = /Chrome\/(\d+)/.exec(globalThis.navigator?.userAgent ?? "")?.[1];
  return [
    `资产助手 ${version} · Codex 连接诊断 · ${new Date().toISOString()}`,
    `模型 ${model || "-"} · Chrome ${browser ?? "-"} · ${globalThis.navigator?.onLine === false ? "浏览器离线" : "浏览器在线"}`,
    ...steps.map((step, index) => `${STATUS_MARK[step.status]} ${index + 1}. ${step.label}${step.ms !== undefined ? `（${step.ms}ms）` : ""}：${step.detail}`),
  ].join("\n");
}
