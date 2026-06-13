import { countTextTokens, tokenizerDescription } from "./tokenizer.js";
import { encodeMessages } from "./v4Encoding.js";
import type { ChatMessage, ChatPayload, FimPayload, TokenCount } from "./types.js";
import { normalizeReasoningEffort } from "./models.js";

export const JSON_OBJECT_RESPONSE_FORMAT_OVERHEAD_TOKENS = 20;
export const FIM_PROMPT_OVERHEAD_TOKENS = 4;

function thinkingEnabled(payload: ChatPayload): boolean {
  return payload.thinking?.type !== "disabled";
}

function convertMessagesForCount(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const converted: ChatMessage = { ...message };
    if (converted.reasoning_content !== undefined && converted.reasoning === undefined) {
      converted.reasoning = converted.reasoning_content;
      delete converted.reasoning_content;
    }
    if (converted.prefix) {
      converted.wo_eos = true;
      delete converted.prefix;
    }
    return converted;
  });
}

function injectToolsForCount(messages: ChatMessage[], tools: ChatPayload["tools"] | undefined): ChatMessage[] {
  if (!tools || tools.length === 0) {
    return messages;
  }
  const converted = messages.map((message) => ({ ...message }));
  const systemMessage = converted.find((message) => message.role === "system");
  if (systemMessage) {
    systemMessage.tools = tools;
    return converted;
  }
  return [{ role: "system", content: "", tools }, ...converted];
}

export function countChatPromptTokens(payload: ChatPayload): TokenCount {
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new Error("Chat payload must contain a non-empty messages array.");
  }

  const messages = injectToolsForCount(convertMessagesForCount(payload.messages), payload.tools);
  const thinkingMode = thinkingEnabled(payload) ? "thinking" : "chat";
  const effort = thinkingMode === "thinking" ? normalizeReasoningEffort(payload.reasoning_effort) : undefined;
  const prompt = encodeMessages(messages, {
    thinkingMode,
    ...(effort ? { reasoningEffort: effort } : {}),
  });
  let tokens = countTextTokens(prompt);
  const notes: string[] = [];

  if (payload.response_format?.type === "json_object") {
    tokens += JSON_OBJECT_RESPONSE_FORMAT_OVERHEAD_TOKENS;
    notes.push(`Added ${JSON_OBJECT_RESPONSE_FORMAT_OVERHEAD_TOKENS} tokens for DeepSeek JSON response_format preamble.`);
  }

  return {
    tokens,
    tokenizer: tokenizerDescription(),
    promptFormat: "deepseek-v4-chat",
    notes,
  };
}

export function countFimPromptTokens(payload: Pick<FimPayload, "prompt" | "suffix">): TokenCount {
  const tokens = countTextTokens(payload.prompt + (payload.suffix ?? "")) + FIM_PROMPT_OVERHEAD_TOKENS;
  return {
    tokens,
    tokenizer: tokenizerDescription(),
    promptFormat: "deepseek-fim-beta",
    notes: [`Added ${FIM_PROMPT_OVERHEAD_TOKENS} tokens for DeepSeek FIM prefix/suffix markers.`],
  };
}
