import type {
  ResearchApiProtocol,
  ResearchProviderPreset,
  ResearchProviderSettings,
} from "./types";
import { isGlmModel } from "./thinkingCapabilities";

export type ResearchWebSearchAdapter =
  | "openai_responses"
  | "anthropic_server"
  | "gemini_grounding"
  | "openrouter_plugin"
  | "zhipu_tool"
  | "moonshot_tool"
  | "qwen_search"
  | "perplexity_sonar";

export interface ResearchWebSearchCapability {
  supported: boolean;
  adapter?: ResearchWebSearchAdapter;
  modelDependent: boolean;
  reasonZh: string;
  reasonEn: string;
}

type CapabilityRule = {
  protocols: ResearchApiProtocol[];
  adapter: ResearchWebSearchAdapter;
  modelDependent?: boolean;
};

const RULES: Partial<Record<ResearchProviderPreset, CapabilityRule>> = {
  openai: { protocols: ["responses"], adapter: "openai_responses", modelDependent: true },
  xai: { protocols: ["responses"], adapter: "openai_responses", modelDependent: true },
  volcengine_ark: { protocols: ["responses"], adapter: "openai_responses", modelDependent: true },
  anthropic: { protocols: ["anthropic_messages"], adapter: "anthropic_server", modelDependent: true },
  google_gemini: { protocols: ["gemini_native"], adapter: "gemini_grounding", modelDependent: true },
  openrouter: { protocols: ["chat_completions"], adapter: "openrouter_plugin", modelDependent: true },
  zhipu: { protocols: ["chat_completions"], adapter: "zhipu_tool", modelDependent: true },
  moonshot: { protocols: ["chat_completions"], adapter: "moonshot_tool", modelDependent: true },
  alibaba_qwen: { protocols: ["chat_completions"], adapter: "qwen_search", modelDependent: true },
  perplexity: { protocols: ["chat_completions"], adapter: "perplexity_sonar", modelDependent: true },
};

function customCapability(protocol: ResearchApiProtocol): ResearchWebSearchCapability {
  const adapter = protocol === "responses"
    ? "openai_responses"
    : protocol === "anthropic_messages"
      ? "anthropic_server"
      : protocol === "gemini_native"
        ? "gemini_grounding"
        : undefined;
  if (adapter) {
    return {
      supported: true,
      adapter,
      modelDependent: true,
      reasonZh: "按所选原生协议发送联网工具；是否可用仍取决于自定义服务与模型。",
      reasonEn: "Uses the selected native protocol; availability still depends on the custom service and model.",
    };
  }
  return {
    supported: false,
    modelDependent: true,
    reasonZh: "自定义 Chat Completions 没有统一联网参数，请改用 Responses、Anthropic 或 Gemini 原生协议。",
    reasonEn: "Custom Chat Completions has no universal web-search parameter. Use Responses, Anthropic, or native Gemini.",
  };
}

function inferResearchWebSearchCapability(
  settings: Pick<ResearchProviderSettings, "preset" | "protocol" | "model">,
): ResearchWebSearchCapability {
  if (settings.preset === "custom") return customCapability(settings.protocol);
  if (settings.preset === "volcengine_agent_plan") {
    return {
      supported: false,
      modelDependent: false,
      reasonZh: "方舟 Agent Plan 的联网搜索属于独立 Harness 能力，需要在“联网搜索”页另行配置方舟联网搜索 Key；模型 API Key 不会自动启用 web_search。",
      reasonEn: "Ark Agent Plan web search is a separate Harness capability. Configure a Volcengine Search key in the Web search tab; the model API key does not enable web_search.",
    };
  }
  const rule = RULES[settings.preset];
  if (!rule) {
    return {
      supported: false,
      modelDependent: false,
      reasonZh: "当前服务商预设尚未接入可验证的原生联网协议。",
      reasonEn: "This provider preset has no verified native web-search integration.",
    };
  }
  if (!rule.protocols.includes(settings.protocol)) {
    const protocolNames = rule.protocols.map((protocol) => ({
      responses: "Responses API",
      anthropic_messages: "Anthropic Messages",
      gemini_native: "Gemini GenerateContent",
      chat_completions: "Chat Completions",
      ollama_chat: "Ollama Chat",
    })[protocol]).join(" / ");
    return {
      supported: false,
      modelDependent: Boolean(rule.modelDependent),
      reasonZh: `该服务商联网需要 ${protocolNames} 协议。`,
      reasonEn: `Web search for this provider requires ${protocolNames}.`,
    };
  }
  const isArk = settings.preset === "volcengine_ark";
  const model = settings.model.toLowerCase();
  if (isArk && isGlmModel(model)) {
    return {
      supported: true,
      adapter: rule.adapter,
      modelDependent: true,
      reasonZh: "插件会按方舟 Responses 发送 web_search 工具；但 GLM 在当前方舟套餐里是否返回联网事件/引用取决于模型能力，请以“测试原生联网”为准。",
      reasonEn: "The plugin sends Ark Responses web_search tools; GLM returning search events/citations depends on the model/plan. Use Test native web to verify.",
    };
  }
  return {
    supported: true,
    adapter: rule.adapter,
    modelDependent: Boolean(rule.modelDependent),
    reasonZh: settings.model
      ? "协议已接入；保存前建议执行“测试联网”确认当前模型可用。"
      : "协议已接入；选择模型后请执行“测试联网”。",
    reasonEn: settings.model
      ? "Protocol integrated. Test web search to confirm support for the selected model."
      : "Protocol integrated. Select a model, then test web search.",
  };
}

export function getResearchWebSearchCapability(
  settings: Pick<ResearchProviderSettings, "preset" | "protocol" | "model" | "nativeWebSearchVerification">,
): ResearchWebSearchCapability {
  const inferred = inferResearchWebSearchCapability(settings);
  // A saved diagnostic cannot turn an architecturally unsupported route into
  // a native-search route (for example Agent Plan's separate Harness search).
  if (!inferred.supported) return inferred;
  const verification = settings.nativeWebSearchVerification;
  const matchesCurrentModel = verification
    && verification.model === settings.model
    && verification.protocol === settings.protocol;
  if (!matchesCurrentModel) return inferred;
  if (verification.status === "failed") {
    return {
      ...inferred,
      // A diagnostic failure is evidence about the last request, not a permanent
      // capability switch. Providers, plans and model availability can change.
      supported: inferred.supported,
      modelDependent: true,
      reasonZh: `上次联网检测失败（${new Date(verification.checkedAt).toLocaleString("zh-CN")}）：${verification.message}。这不会永久关闭原生联网，可重新检测；研究时仍会自动尝试并使用可用兜底。`,
      reasonEn: `The last web-access diagnostic failed (${new Date(verification.checkedAt).toLocaleString("en-US")}): ${verification.message}. Native browsing is not permanently disabled; retry the diagnostic when needed.`,
    };
  }
  return {
    ...inferred,
    supported: true,
    reasonZh: `当前模型已于 ${new Date(verification.checkedAt).toLocaleString("zh-CN")} 验证原生联网。`,
    reasonEn: `Native web was verified for this model on ${new Date(verification.checkedAt).toLocaleString("en-US")}.`,
  };
}
