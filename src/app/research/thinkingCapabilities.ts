import type {
  ResearchModelDefinition,
  ResearchProviderSettings,
  ResearchThinkingLevel,
} from "./types";

export interface ResearchThinkingOption {
  value: ResearchThinkingLevel;
  label: string;
  labelEn: string;
}

export interface ResearchThinkingControl {
  options: ResearchThinkingOption[];
  note: string;
  noteEn: string;
  source: "provider" | "model" | "protocol";
}

const THINKING_RANK: Partial<Record<ResearchThinkingLevel, number>> = {
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

/** Shared GLM model detection. Used by both thinking and web-search
 *  capability checks so the two never diverge on what counts as "GLM". */
export function isGlmModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return /\bglm[-_:]/.test(id) || id.startsWith("glm");
}

const OPTIONS: Record<ResearchThinkingLevel, ResearchThinkingOption> = {
  auto: { value: "auto", label: "自动（服务商默认）", labelEn: "Automatic (provider default)" },
  off: { value: "off", label: "关闭", labelEn: "Off" },
  enabled: { value: "enabled", label: "开启（模型自动）", labelEn: "On (model decides)" },
  minimal: { value: "minimal", label: "最小", labelEn: "Minimal" },
  low: { value: "low", label: "低", labelEn: "Low" },
  medium: { value: "medium", label: "中", labelEn: "Medium" },
  high: { value: "high", label: "高", labelEn: "High" },
  xhigh: { value: "xhigh", label: "超高（xhigh）", labelEn: "Extra high (xhigh)" },
  max: { value: "max", label: "最大（max）", labelEn: "Maximum (max)" },
};

function options(values: ResearchThinkingLevel[]) {
  return values.map((value) => OPTIONS[value]);
}

function selectedModel(settings: ResearchProviderSettings): ResearchModelDefinition | undefined {
  return settings.models.find((model) => model.id === settings.model);
}

function fromModelMetadata(settings: ResearchProviderSettings): ResearchThinkingControl | null {
  const reasoning = selectedModel(settings)?.reasoning;
  const efforts = reasoning?.supportedEfforts?.filter((effort) => effort !== "auto" && effort !== "enabled") ?? [];
  if (!efforts.length) return null;
  const values: ResearchThinkingLevel[] = ["auto"];
  if (!reasoning?.mandatory && !efforts.includes("off")) values.push("off");
  for (const effort of efforts) if (!values.includes(effort)) values.push(effort);
  return {
    options: options(values),
    source: "model",
    note: `选项来自模型列表返回的能力声明${reasoning?.mandatory ? "；该模型要求始终推理" : ""}。`,
    noteEn: `Options come from the model-list capability metadata${reasoning?.mandatory ? "; reasoning is mandatory for this model" : ""}.`,
  };
}

function geminiControl(model: string): ResearchThinkingControl {
  const id = model.toLowerCase();
  if (id.includes("gemini-2.5")) {
    return {
      options: options(["auto", "off", "low", "medium", "high"]),
      source: "model",
      note: "Gemini 2.5 会把等级换算为 thinkingBudget；部分 Pro 模型不能完全关闭思考。",
      noteEn: "Gemini 2.5 maps levels to thinkingBudget; some Pro models cannot fully disable thinking.",
    };
  }
  if (/gemini-3(\.1)?-pro/.test(id)) {
    return {
      options: options(["auto", "low", "medium", "high"]),
      source: "model",
      note: "此 Gemini Pro 型号不提供 minimal/off，直接使用原生 thinkingLevel。",
      noteEn: "This Gemini Pro model does not expose minimal/off; native thinkingLevel values are used.",
    };
  }
  if (id.includes("flash-lite-image")) {
    return {
      options: options(["auto", "minimal", "high"]),
      source: "model",
      note: "该 Gemini 图像型号只声明 minimal 与 high。",
      noteEn: "This Gemini image model only declares minimal and high.",
    };
  }
  return {
    options: options(["auto", "minimal", "low", "medium", "high"]),
    source: "protocol",
    note: model ? "按 Gemini 3 thinkingLevel 发送；最终可用档位仍由具体型号决定。" : "选择模型后会按 Gemini 2.5 或 Gemini 3 自动切换参数与档位。",
    noteEn: model ? "Uses Gemini 3 thinkingLevel; exact levels still depend on the model." : "Select a model to switch automatically between Gemini 2.5 and Gemini 3 controls.",
  };
}

function anthropicControl(model: string): ResearchThinkingControl {
  const id = model.toLowerCase();
  const alwaysThinking = /fable|mythos/.test(id);
  const supportsXhigh = /fable|mythos|sonnet-5|opus-4-[78]/.test(id);
  const supportsMax = supportsXhigh || /sonnet-4-6|opus-4-[56]/.test(id);
  const values: ResearchThinkingLevel[] = ["auto"];
  if (!alwaysThinking) values.push("off");
  values.push("low", "medium", "high");
  if (supportsXhigh) values.push("xhigh");
  if (supportsMax) values.push("max");
  return {
    options: options(values),
    source: model ? "model" : "protocol",
    note: supportsXhigh
      ? "使用 Claude adaptive thinking + effort；当前型号支持 xhigh/max。"
      : supportsMax
        ? "使用 Claude adaptive thinking + effort；当前型号支持 max，但不开放 xhigh。"
      : model
        ? "使用 Claude effort；当前模型未识别为支持 xhigh/max 的型号。"
        : "选择具体 Claude 模型后，会判断是否开放 xhigh/max 以及能否关闭思考。",
    noteEn: supportsXhigh
      ? "Uses Claude adaptive thinking + effort; this model supports xhigh/max."
      : supportsMax
        ? "Uses Claude adaptive thinking + effort; this model supports max but not xhigh."
      : model
        ? "Uses Claude effort; this model is not recognized as supporting xhigh/max."
        : "Select a Claude model to determine xhigh/max and whether thinking can be disabled.",
  };
}

function arkResponsesControl(model: string): ResearchThinkingControl {
  const id = model.toLowerCase();
  const isGlm = isGlmModel(id);
  return {
    options: options(["auto", "off", "low", "medium", "high", "xhigh", "max"]),
    source: isGlm ? "model" : "provider",
    note: isGlm
      ? "方舟 GLM 按 Responses reasoning.effort 发送，可选择 xhigh/max；如果具体套餐拒绝，插件会自动降级重试。"
      : "方舟 Responses 未返回逐模型能力时不预判高级档位是否支持；若服务商拒绝，插件会自动降级重试。",
    noteEn: isGlm
      ? "Ark GLM uses Responses reasoning.effort and can select xhigh/max; if a plan rejects it, the plugin retries with a lower effort."
      : "When Ark Responses does not return per-model capabilities, advanced levels remain selectable; if rejected, the plugin retries with a lower effort.",
  };
}

export function getResearchThinkingControl(settings: ResearchProviderSettings): ResearchThinkingControl {
  const metadata = fromModelMetadata(settings);
  if (metadata) return metadata;
  const model = settings.model || settings.fastModel;

  if (settings.protocol === "gemini_native") return geminiControl(model);
  if (settings.protocol === "anthropic_messages") return anthropicControl(model);
  if (settings.protocol === "ollama_chat") {
    const gptOss = model.toLowerCase().includes("gpt-oss");
    return {
      options: options(gptOss ? ["auto", "low", "medium", "high"] : ["auto", "off", "enabled"]),
      source: model ? "model" : "protocol",
      note: gptOss
        ? "Ollama 的 GPT-OSS 原生支持 low/medium/high，且不能完全关闭思考。"
        : "多数 Ollama 思考模型只支持开/关；只有声明分档的模型才显示强度等级。",
      noteEn: gptOss
        ? "Ollama GPT-OSS supports low/medium/high and cannot fully disable thinking."
        : "Most Ollama thinking models only support on/off; levels appear only for models that declare them.",
    };
  }

  if (settings.preset === "openrouter") {
    return {
      options: options(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]),
      source: "provider",
      note: "OpenRouter 会再按所选模型映射；获取模型列表后可使用模型返回的精确档位。",
      noteEn: "OpenRouter maps the value to the selected model; fetch models for exact model-declared levels.",
    };
  }

  if (settings.preset.startsWith("volcengine_") && settings.protocol === "responses") {
    return arkResponsesControl(model);
  }

  if (settings.protocol === "responses" || settings.preset === "openai") {
    return {
      options: options(["auto", "off", "minimal", "low", "medium", "high", "xhigh"]),
      source: "protocol",
      note: "按 OpenAI reasoning effort 原值发送；个别模型只接受其中部分档位。",
      noteEn: "Sent as OpenAI reasoning effort; individual models may accept only a subset.",
    };
  }

  if (settings.preset === "xai" || settings.preset === "custom") {
    return {
      options: options(["auto", "off", "low", "medium", "high"]),
      source: "provider",
      note: "这是兼容协议的通用档位；接口不支持时请保持“自动”。",
      noteEn: "These are generic compatibility levels; keep Automatic if the endpoint does not support them.",
    };
  }

  return {
    options: options(["auto"]),
    source: "provider",
    note: "该预设没有统一的思考强度参数，思考行为由所选模型 ID 决定，不会附加可能导致报错的字段。",
    noteEn: "This preset has no unified thinking-effort parameter. The model ID controls reasoning, so no risky extra field is sent.",
  };
}

export function effectiveResearchThinkingLevel(settings: ResearchProviderSettings): ResearchThinkingLevel {
  const control = getResearchThinkingControl(settings);
  return resolveEffectiveResearchThinkingLevel(settings.thinkingLevel, control);
}

export function resolveEffectiveResearchThinkingLevel(
  requested: ResearchThinkingLevel,
  control: ResearchThinkingControl,
): ResearchThinkingLevel {
  const available = control.options.map((option) => option.value);
  if (available.includes(requested)) return requested;
  if (requested === "auto" || requested === "off") return "auto";

  const requestedRank = THINKING_RANK[requested];
  const rankedAvailable = available
    .flatMap((value) => {
      const rank = THINKING_RANK[value];
      return rank === undefined ? [] : [{ value, rank }];
    })
    .sort((left, right) => right.rank - left.rank);
  if (requestedRank !== undefined) {
    const nearestSupported = rankedAvailable.find((item) => item.rank <= requestedRank);
    if (nearestSupported) return nearestSupported.value;
  }
  return rankedAvailable[0]?.value ?? (available.includes("enabled") ? "enabled" : "auto");
}
