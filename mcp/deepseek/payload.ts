import { canonicalModelAndThinking, modelSpec, normalizeReasoningEffort } from "./models.js";
import type { ChatMessage, ChatPayload, ChatRequestOptions, DeepSeekPayload, FimPayload, FimRequestOptions, RequestOptions, StopSequences, ValidationResult } from "./types.js";
import { countChatPromptTokens, countFimPromptTokens } from "./tokenCounter.js";
import type { EndpointMode } from "./models.js";
import { estimateCost } from "./cost.js";

export const DEFAULT_CHAT_MAX_TOKENS = 384_000;
export const DEFAULT_FIM_MAX_TOKENS = 4_096;

export interface BuildPayloadResult {
  endpoint: EndpointMode;
  payload: DeepSeekPayload;
  notes: string[];
}

export interface ValidatePayloadOptions {
  contextTokens?: number;
  reserveOutputTokens?: number;
  safetyMarginTokens?: number;
}

function normalizeStop(stop: string | string[] | undefined): string | string[] | undefined {
  if (Array.isArray(stop)) {
    if (stop.length === 0) {
      return undefined;
    }
    if (stop.length > 16) {
      throw new Error("DeepSeek supports at most 16 stop sequences.");
    }
    return stop.length === 1 ? stop[0] : stop;
  }
  return stop;
}

function assertRange(name: string, value: number | undefined, min: number, max: number): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
}

function assertNonNegativeInteger(name: string, value: number | undefined, max?: number): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${name} cannot exceed ${max}.`);
  }
}

function validateSharedOptions(options: RequestOptions, notes: string[]): StopSequences | undefined {
  const stop = normalizeStop(options.stop);
  assertRange("temperature", options.temperature, 0, 2);
  assertRange("topP", options.topP, 0, 1);
  if (options.frequencyPenalty !== undefined) {
    notes.push("frequency_penalty is deprecated by DeepSeek and has no effect.");
  }
  if (options.presencePenalty !== undefined) {
    notes.push("presence_penalty is deprecated by DeepSeek and has no effect.");
  }
  return stop;
}

export function buildChatPayload(prompt: string, options: ChatRequestOptions = {}): BuildPayloadResult {
  const { model, thinking, notes } = canonicalModelAndThinking(options.model, options.thinking ?? "enabled");
  const stop = validateSharedOptions(options, notes);
  assertNonNegativeInteger("maxTokens", options.maxTokens, modelSpec(model).maxOutputTokens);
  assertNonNegativeInteger("topLogprobs", options.topLogprobs, 20);
  if (options.topLogprobs !== undefined && !options.logprobs) {
    throw new Error("topLogprobs requires logprobs=true.");
  }
  if (options.userId !== undefined && !/^[a-zA-Z0-9\-_]{1,512}$/.test(options.userId)) {
    throw new Error("userId must match [a-zA-Z0-9\\-_]{1,512}.");
  }
  if (thinking !== "disabled" && (options.temperature !== undefined || options.topP !== undefined)) {
    notes.push("temperature/top_p are ignored by DeepSeek while thinking mode is enabled.");
  }
  if (options.tools && options.tools.length > 128) {
    throw new Error("DeepSeek supports at most 128 tools.");
  }

  const messages = buildChatMessages(prompt, options);
  const payload: ChatPayload = { model, messages };
  if (options.stream !== undefined) payload.stream = options.stream;
  if (thinking !== "omit") payload.thinking = { type: thinking };
  if (thinking !== "disabled") {
    const effort = normalizeReasoningEffort(options.reasoningEffort ?? process.env.DEEPSEEK_REASONING_EFFORT ?? "high");
    if (effort) payload.reasoning_effort = effort;
  }
  if (options.maxTokens === undefined) payload.max_tokens = DEFAULT_CHAT_MAX_TOKENS;
  else if (options.maxTokens > 0) payload.max_tokens = options.maxTokens;
  if (options.responseFormat === "json_object") payload.response_format = { type: "json_object" };
  if (stop !== undefined) payload.stop = stop;
  if (options.temperature !== undefined) payload.temperature = options.temperature;
  if (options.topP !== undefined) payload.top_p = options.topP;
  if (options.logprobs) payload.logprobs = true;
  if (options.topLogprobs !== undefined) payload.top_logprobs = options.topLogprobs;
  if (options.tools !== undefined) payload.tools = options.tools;
  if (options.toolChoice !== undefined) payload.tool_choice = options.toolChoice;
  if (options.userId !== undefined) payload.user_id = options.userId;
  if (options.frequencyPenalty !== undefined) payload.frequency_penalty = options.frequencyPenalty;
  if (options.presencePenalty !== undefined) payload.presence_penalty = options.presencePenalty;
  if (options.stream && options.includeUsage) payload.stream_options = { include_usage: true };
  if (options.extra) Object.assign(payload, options.extra);

  return { endpoint: "chat", payload, notes };
}

export function buildChatMessages(prompt: string, options: ChatRequestOptions): ChatMessage[] {
  if (options.messages) {
    return options.messages;
  }
  const messages: ChatMessage[] = [];
  if (options.system !== undefined) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push({ role: "user", content: prompt });
  if (options.assistantPrefix !== undefined || options.prefixReasoning !== undefined) {
    const prefixMessage: ChatMessage = {
      role: "assistant",
      content: options.assistantPrefix ?? "",
      prefix: true,
    };
    if (options.prefixReasoning !== undefined) {
      prefixMessage.reasoning_content = options.prefixReasoning;
    }
    messages.push(prefixMessage);
  }
  return messages;
}

export function buildFimPayload(prompt: string, options: FimRequestOptions): BuildPayloadResult {
  const { model, notes } = canonicalModelAndThinking(options.model, "omit");
  const stop = validateSharedOptions(options, notes);
  const spec = modelSpec(model);
  if (!spec.supportsFim) {
    throw new Error("DeepSeek FIM beta currently supports deepseek-v4-pro only.");
  }
  assertNonNegativeInteger("fimMaxTokens", options.fimMaxTokens, DEFAULT_FIM_MAX_TOKENS);
  assertNonNegativeInteger("fimLogprobs", options.fimLogprobs, 20);

  const payload: FimPayload = { model, prompt };
  if (options.suffix !== undefined) payload.suffix = options.suffix;
  if (options.stream !== undefined) payload.stream = options.stream;
  if (options.fimMaxTokens === undefined) payload.max_tokens = DEFAULT_FIM_MAX_TOKENS;
  else if (options.fimMaxTokens > 0) payload.max_tokens = options.fimMaxTokens;
  if (stop !== undefined) payload.stop = stop;
  if (options.temperature !== undefined) payload.temperature = options.temperature;
  if (options.topP !== undefined) payload.top_p = options.topP;
  if (options.echo) payload.echo = true;
  if (options.fimLogprobs !== undefined) payload.logprobs = options.fimLogprobs;
  if (options.frequencyPenalty !== undefined) payload.frequency_penalty = options.frequencyPenalty;
  if (options.presencePenalty !== undefined) payload.presence_penalty = options.presencePenalty;
  if (options.stream && options.includeUsage) payload.stream_options = { include_usage: true };
  if (options.extra) Object.assign(payload, options.extra);

  return { endpoint: "fim", payload, notes };
}

export function buildPayload(prompt: string, options: RequestOptions = {}): BuildPayloadResult {
  if (options.endpoint === "fim") {
    return buildFimPayload(prompt, options);
  }
  return buildChatPayload(prompt, options);
}

function safetyMargin(contextTokens: number, explicit: number | undefined): number {
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || explicit < 0) {
      throw new Error("safetyMarginTokens must be a non-negative integer.");
    }
    return explicit;
  }
  return Math.max(100, Math.ceil(contextTokens * 0.001));
}

export function validatePayload(payloadResult: BuildPayloadResult, options: ValidatePayloadOptions = {}): ValidationResult {
  const payload = payloadResult.payload;
  const endpoint = payloadResult.endpoint;
  const spec = modelSpec(payload.model);
  const tokenCount = endpoint === "chat" ? countChatPromptTokens(payload as ChatPayload) : countFimPromptTokens(payload as FimPayload);
  const desiredOutputTokens = typeof payload.max_tokens === "number" ? payload.max_tokens : 0;
  const contextTokens = options.contextTokens ?? spec.contextTokens;
  const reservedOutputTokens = options.reserveOutputTokens ?? desiredOutputTokens;
  const margin = safetyMargin(contextTokens, options.safetyMarginTokens);
  const availableInputTokens = contextTokens - reservedOutputTokens - margin;
  const totalReservedTokens = tokenCount.tokens + reservedOutputTokens + margin;
  const headroomTokens = contextTokens - totalReservedTokens;
  const maxPossibleResponseTokens = Math.max(0, contextTokens - tokenCount.tokens - margin);
  const costEstimate = estimateCost(payload.model, tokenCount.tokens, reservedOutputTokens);

  let status: ValidationResult["status"];
  let fits: boolean;
  let reason: string;
  if (availableInputTokens <= 0) {
    status = "ERROR";
    fits = false;
    reason = "Reserved output budget plus safety margin exceeds the context window.";
  } else if (tokenCount.tokens > availableInputTokens) {
    status = "ERROR";
    fits = false;
    reason = "Input tokens exceed the available input budget.";
  } else if (tokenCount.tokens > 0.95 * availableInputTokens) {
    status = "CRITICAL_WARNING";
    fits = true;
    reason = "Prompt fits, but it is extremely close to the limit.";
  } else if (tokenCount.tokens > 0.8 * availableInputTokens) {
    status = "WARNING";
    fits = true;
    reason = "Prompt fits, but it uses more than 80% of the available input budget.";
  } else {
    status = "OK";
    fits = true;
    reason = "Prompt fits inside the configured context window.";
  }

  return {
    status,
    fits,
    reason,
    endpoint,
    model: payload.model,
    contextTokens,
    maxModelOutputTokens: spec.maxOutputTokens,
    reservedOutputTokens,
    clientSideOutputCap: desiredOutputTokens > 0,
    safetyMarginTokens: margin,
    availableInputTokens,
    inputTokens: tokenCount.tokens,
    totalReservedTokens,
    headroomTokens,
    maxPossibleResponseTokens,
    costEstimate,
    tokenizer: tokenCount.tokenizer,
    promptFormat: tokenCount.promptFormat,
    notes: [...payloadResult.notes, ...tokenCount.notes],
  };
}
