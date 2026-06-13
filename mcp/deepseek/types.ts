import type { JsonObject, JsonValue } from "../shared/json.js";
import type { CostEstimate } from "./cost.js";
import type { DeepSeekModel, EndpointMode, ReasoningEffort, ThinkingSwitch } from "./models.js";

export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool" | "latest_reminder";
  content?: string | null;
  content_blocks?: ChatContentBlock[];
  reasoning_content?: string | null;
  reasoning?: string | null;
  prefix?: boolean;
  tool_calls?: ToolCall[];
  tools?: ChatTool[];
  response_format?: ResponseFormat;
  task?: string;
  tool_call_id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface ChatContentBlock {
  type: string;
  text?: string;
  content?: unknown;
}

export interface ToolCall {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string | JsonObject;
  };
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: JsonObject;
    strict?: boolean;
  };
}

export type ToolChoice = "none" | "auto" | "required" | JsonObject;
export type ResponseFormat = { type: "text" } | { type: "json_object" };
export type StopSequences = string | string[];

export interface CommonRequestOptions {
  endpoint?: EndpointMode;
  model?: DeepSeekModel | "deepseek-chat" | "deepseek-reasoner";
  stop?: StopSequences;
  stream?: boolean;
  includeUsage?: boolean;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  extra?: Record<string, unknown>;
  baseUrl?: string;
  apiUrl?: string;
}

export interface ChatRequestOptions extends CommonRequestOptions {
  endpoint?: "chat";
  system?: string;
  messages?: ChatMessage[];
  assistantPrefix?: string;
  prefixReasoning?: string;
  thinking?: ThinkingSwitch;
  reasoningEffort?: ReasoningEffort | "low" | "medium" | "xhigh";
  maxTokens?: number;
  responseFormat?: "text" | "json_object";
  logprobs?: boolean;
  topLogprobs?: number;
  tools?: ChatTool[];
  toolChoice?: ToolChoice;
  userId?: string;
}

export interface FimRequestOptions extends CommonRequestOptions {
  endpoint: "fim";
  suffix?: string;
  fimMaxTokens?: number;
  echo?: boolean;
  fimLogprobs?: number;
}

export type RequestOptions = ChatRequestOptions | FimRequestOptions;

export type ChatPayload = {
  model: DeepSeekModel;
  messages: ChatMessage[];
  stream?: boolean;
  thinking?: { type: Exclude<ThinkingSwitch, "omit"> };
  reasoning_effort?: ReasoningEffort;
  max_tokens?: number;
  response_format?: ResponseFormat;
  stop?: StopSequences;
  temperature?: number;
  top_p?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  tools?: ChatTool[];
  tool_choice?: ToolChoice;
  user_id?: string;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream_options?: { include_usage: boolean };
} & Record<string, unknown>;

export type FimPayload = {
  model: DeepSeekModel;
  prompt: string;
  suffix?: string;
  stream?: boolean;
  max_tokens?: number;
  stop?: StopSequences;
  temperature?: number;
  top_p?: number;
  echo?: boolean;
  logprobs?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream_options?: { include_usage: boolean };
} & Record<string, unknown>;

export type DeepSeekPayload = ChatPayload | FimPayload;

export interface TokenCount {
  tokens: number;
  tokenizer: string;
  promptFormat: string;
  notes: string[];
}

export interface ValidationResult {
  status: "OK" | "WARNING" | "CRITICAL_WARNING" | "ERROR";
  fits: boolean;
  reason: string;
  endpoint: EndpointMode;
  model: DeepSeekModel;
  contextTokens: number;
  maxModelOutputTokens: number;
  reservedOutputTokens: number;
  clientSideOutputCap: boolean;
  safetyMarginTokens: number;
  availableInputTokens: number;
  inputTokens: number;
  totalReservedTokens: number;
  headroomTokens: number;
  maxPossibleResponseTokens: number;
  costEstimate: CostEstimate;
  tokenizer: string;
  promptFormat: string;
  notes: string[];
}

export interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: JsonObject;
  [key: string]: JsonValue | undefined;
}
