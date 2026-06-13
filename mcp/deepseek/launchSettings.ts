import type { BuildPayloadResult, ValidatePayloadOptions } from "./payload.js";
import type { ChatPayload, DeepSeekPayload, FimPayload, RequestOptions, ValidationResult } from "./types.js";

type LaunchSource = "mcp-archived-request" | "mcp-direct-prompt";

export interface DeepSeekLaunchSettings {
  source: LaunchSource;
  requestedOptions: Record<string, unknown>;
  effectiveOptions?: Record<string, unknown>;
  effectiveApiParameters: Record<string, unknown>;
  validation?: LaunchValidationSettings;
  archive?: {
    overwriteResponse: boolean;
    previewChars: number;
  };
  transport?: Record<string, unknown>;
}

interface LaunchValidationSettings {
  options: Record<string, unknown>;
  validateBeforeSend: boolean;
  allowOversize: boolean;
  result: Pick<
    ValidationResult,
    | "status"
    | "fits"
    | "endpoint"
    | "model"
    | "contextTokens"
    | "reservedOutputTokens"
    | "safetyMarginTokens"
    | "inputTokens"
    | "totalReservedTokens"
    | "headroomTokens"
    | "maxPossibleResponseTokens"
  >;
}

interface McpLaunchSettingsInput {
  source: Extract<LaunchSource, "mcp-archived-request" | "mcp-direct-prompt">;
  requestedOptions: RequestOptions;
  effectiveOptions: RequestOptions;
  validationOptions: ValidatePayloadOptions | undefined;
  validateBeforeSend: boolean;
  allowOversize: boolean;
  overwriteResponse: boolean;
  previewChars: number;
  payloadResult: BuildPayloadResult;
  validationResult: ValidationResult;
  transport: Record<string, unknown>;
}

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, unknown] => entry[1] !== undefined));
}

function summarizeTools(tools: ChatPayload["tools"] | undefined): Record<string, unknown> | undefined {
  if (!tools) {
    return undefined;
  }
  return {
    count: tools.length,
    names: tools.map((tool) => tool.function.name),
  };
}

function summarizeMessages(messages: ChatPayload["messages"] | undefined): Record<string, unknown> | undefined {
  if (!messages) {
    return undefined;
  }
  return {
    count: messages.length,
    roles: messages.map((message) => message.role),
    hasReasoningContent: messages.some((message) => typeof message.reasoning_content === "string" || typeof message.reasoning === "string"),
    hasAssistantPrefix: messages.some((message) => Boolean(message.prefix)),
  };
}

function summarizeRequestedOptions(options: RequestOptions): Record<string, unknown> {
  return withoutUndefined({
    endpoint: options.endpoint,
    model: options.model,
    stop: options.stop,
    stream: options.stream,
    includeUsage: options.includeUsage,
    temperature: options.temperature,
    topP: options.topP,
    frequencyPenalty: options.frequencyPenalty,
    presencePenalty: options.presencePenalty,
    baseUrl: options.baseUrl,
    apiUrl: options.apiUrl,
    extraKeys: options.extra ? Object.keys(options.extra).sort() : undefined,
    ...(options.endpoint === "fim"
      ? {
          fimMaxTokens: options.fimMaxTokens,
          echo: options.echo,
          fimLogprobs: options.fimLogprobs,
          hasSuffix: options.suffix !== undefined,
        }
      : {
          thinking: options.thinking,
          reasoning: options.reasoningEffort,
          maxTokens: options.maxTokens,
          responseFormat: options.responseFormat,
          logprobs: options.logprobs,
          topLogprobs: options.topLogprobs,
          userId: options.userId,
          toolChoice: options.toolChoice,
          hasSystem: options.system !== undefined,
          messages: options.messages ? { count: options.messages.length, roles: options.messages.map((message) => message.role) } : undefined,
          hasAssistantPrefix: options.assistantPrefix !== undefined,
          hasPrefixReasoning: options.prefixReasoning !== undefined,
          tools: summarizeTools(options.tools),
        }),
  });
}

function nonContentPayloadKeys(payload: DeepSeekPayload): string[] {
  const contentKeys = new Set(["messages", "tools", "prompt", "suffix"]);
  const knownSettings = new Set([
    "model",
    "stream",
    "stream_options",
    "thinking",
    "reasoning_effort",
    "max_tokens",
    "response_format",
    "stop",
    "temperature",
    "top_p",
    "logprobs",
    "top_logprobs",
    "tool_choice",
    "user_id",
    "frequency_penalty",
    "presence_penalty",
    "echo",
  ]);
  return Object.keys(payload)
    .filter((key) => !contentKeys.has(key) && !knownSettings.has(key))
    .sort();
}

function summarizeEffectiveApiParameters(payloadResult: BuildPayloadResult): Record<string, unknown> {
  const payload = payloadResult.payload;
  const shared = {
    endpoint: payloadResult.endpoint,
    model: payload.model,
    stream: payload.stream,
    maxTokens: payload.max_tokens,
    stop: payload.stop,
    temperature: payload.temperature,
    topP: payload.top_p,
    frequencyPenalty: payload.frequency_penalty,
    presencePenalty: payload.presence_penalty,
    streamOptions: payload.stream_options,
    additionalParameterKeys: nonContentPayloadKeys(payload),
  };

  if (payloadResult.endpoint === "fim") {
    const fimPayload = payload as FimPayload;
    return withoutUndefined({
      ...shared,
      echo: fimPayload.echo,
      logprobs: fimPayload.logprobs,
      hasSuffix: fimPayload.suffix !== undefined,
    });
  }

  const chatPayload = payload as ChatPayload;
  return withoutUndefined({
    ...shared,
    thinking: chatPayload.thinking,
    reasoning: chatPayload.reasoning_effort,
    responseFormat: chatPayload.response_format,
    logprobs: chatPayload.logprobs,
    topLogprobs: chatPayload.top_logprobs,
    toolChoice: chatPayload.tool_choice,
    userId: chatPayload.user_id,
    messages: summarizeMessages(chatPayload.messages),
    tools: summarizeTools(chatPayload.tools),
  });
}

function summarizeValidationResult(result: ValidationResult): LaunchValidationSettings["result"] {
  return {
    status: result.status,
    fits: result.fits,
    endpoint: result.endpoint,
    model: result.model,
    contextTokens: result.contextTokens,
    reservedOutputTokens: result.reservedOutputTokens,
    safetyMarginTokens: result.safetyMarginTokens,
    inputTokens: result.inputTokens,
    totalReservedTokens: result.totalReservedTokens,
    headroomTokens: result.headroomTokens,
    maxPossibleResponseTokens: result.maxPossibleResponseTokens,
  };
}

export function buildMcpDeepSeekLaunchSettings(input: McpLaunchSettingsInput): DeepSeekLaunchSettings {
  return {
    source: input.source,
    requestedOptions: summarizeRequestedOptions(input.requestedOptions),
    effectiveOptions: summarizeRequestedOptions(input.effectiveOptions),
    effectiveApiParameters: summarizeEffectiveApiParameters(input.payloadResult),
    validation: {
      options: withoutUndefined({ ...(input.validationOptions ?? {}) }),
      validateBeforeSend: input.validateBeforeSend,
      allowOversize: input.allowOversize,
      result: summarizeValidationResult(input.validationResult),
    },
    archive: {
      overwriteResponse: input.overwriteResponse,
      previewChars: input.previewChars,
    },
    transport: withoutUndefined(input.transport),
  };
}
