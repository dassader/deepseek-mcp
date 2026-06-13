export const DEEPSEEK_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;
export type DeepSeekModel = (typeof DEEPSEEK_MODELS)[number];

export type ThinkingSwitch = "enabled" | "disabled" | "omit";
export type ReasoningEffort = "high" | "max";
export type EndpointMode = "chat" | "fim";

export interface ModelSpec {
  name: DeepSeekModel;
  contextTokens: number;
  maxOutputTokens: number;
  cacheHitInputUsdPerMillion: number;
  cacheMissInputUsdPerMillion: number;
  outputUsdPerMillion: number;
  concurrencyLimit: number;
  supportsFim: boolean;
}

export const MODEL_SPECS: Record<DeepSeekModel, ModelSpec> = {
  "deepseek-v4-flash": {
    name: "deepseek-v4-flash",
    contextTokens: 1_000_000,
    maxOutputTokens: 384_000,
    cacheHitInputUsdPerMillion: 0.0028,
    cacheMissInputUsdPerMillion: 0.14,
    outputUsdPerMillion: 0.28,
    concurrencyLimit: 2_500,
    supportsFim: false,
  },
  "deepseek-v4-pro": {
    name: "deepseek-v4-pro",
    contextTokens: 1_000_000,
    maxOutputTokens: 384_000,
    cacheHitInputUsdPerMillion: 0.003625,
    cacheMissInputUsdPerMillion: 0.435,
    outputUsdPerMillion: 0.87,
    concurrencyLimit: 500,
    supportsFim: true,
  },
};

const LEGACY_MODEL_ALIASES: Record<string, { model: DeepSeekModel; thinking: Exclude<ThinkingSwitch, "omit"> }> = {
  "deepseek-chat": { model: "deepseek-v4-flash", thinking: "disabled" },
  "deepseek-reasoner": { model: "deepseek-v4-flash", thinking: "enabled" },
};

export function isDeepSeekModel(value: string): value is DeepSeekModel {
  return DEEPSEEK_MODELS.includes(value as DeepSeekModel);
}

export function modelSpec(model: string): ModelSpec {
  const canonical = canonicalModelAndThinking(model, "omit").model;
  return MODEL_SPECS[canonical];
}

export function canonicalModelAndThinking(
  model: string | undefined,
  thinking: ThinkingSwitch | undefined,
): { model: DeepSeekModel; thinking: ThinkingSwitch; notes: string[] } {
  const selectedModel = model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro";
  const selectedThinking = thinking ?? ((process.env.DEEPSEEK_THINKING as ThinkingSwitch | undefined) ?? "enabled");
  const notes: string[] = [];

  const alias = LEGACY_MODEL_ALIASES[selectedModel];
  if (alias) {
    notes.push(`${selectedModel} is deprecated; using ${alias.model} with thinking=${alias.thinking}.`);
    return {
      model: alias.model,
      thinking: selectedThinking === "omit" ? alias.thinking : selectedThinking,
      notes,
    };
  }

  if (!isDeepSeekModel(selectedModel)) {
    throw new Error(`Unsupported DeepSeek model ${JSON.stringify(selectedModel)}. Use deepseek-v4-flash or deepseek-v4-pro.`);
  }

  if (!["enabled", "disabled", "omit"].includes(selectedThinking)) {
    throw new Error("thinking must be enabled, disabled, or omit.");
  }

  return { model: selectedModel, thinking: selectedThinking, notes };
}

export function normalizeReasoningEffort(value: string | undefined | null): ReasoningEffort | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const lowered = value.toLowerCase();
  if (lowered === "max" || lowered === "xhigh") {
    return "max";
  }
  if (lowered === "high" || lowered === "medium" || lowered === "low") {
    return "high";
  }
  throw new Error("reasoningEffort must be high or max.");
}

