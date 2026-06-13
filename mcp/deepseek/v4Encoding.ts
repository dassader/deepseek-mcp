import type { ChatMessage, ChatTool, ToolCall } from "./types.js";
import { toJson } from "../shared/json.js";

export const BOS_TOKEN = "<｜begin▁of▁sentence｜>";
export const EOS_TOKEN = "<｜end▁of▁sentence｜>";
export const THINKING_START_TOKEN = "<think>";
export const THINKING_END_TOKEN = "</think>";
export const DSML_TOKEN = "｜DSML｜";
export const USER_SP_TOKEN = "<｜User｜>";
export const ASSISTANT_SP_TOKEN = "<｜Assistant｜>";
export const LATEST_REMINDER_SP_TOKEN = "<｜latest_reminder｜>";

const DS_TASK_SP_TOKENS: Record<string, string> = {
  action: "<｜action｜>",
  query: "<｜query｜>",
  authority: "<｜authority｜>",
  domain: "<｜domain｜>",
  title: "<｜title｜>",
  read_url: "<｜read_url｜>",
};

const REASONING_EFFORT_MAX =
  "Reasoning Effort: Absolute maximum with no shortcuts permitted.\n" +
  "You MUST be very thorough in your thinking and comprehensively decompose the problem to resolve the root cause, rigorously stress-testing your logic against all potential paths, edge cases, and adversarial scenarios.\n" +
  "Explicitly write out your entire deliberation process, documenting every intermediate step, considered alternative, and rejected hypothesis to ensure absolutely no assumption is left unchecked.\n\n";

const TOOLS_TEMPLATE = `## Tools

You have access to a set of tools to help answer the user's question. You can invoke tools by writing a "<{dsml_token}tool_calls>" block like the following:

<{dsml_token}tool_calls>
<{dsml_token}invoke name="$TOOL_NAME">
<{dsml_token}parameter name="$PARAMETER_NAME" string="true|false">$PARAMETER_VALUE</{dsml_token}parameter>
...
</{dsml_token}invoke>
<{dsml_token}invoke name="$TOOL_NAME2">
...
</{dsml_token}invoke>
</{dsml_token}tool_calls>

String parameters should be specified as is and set \`string="true"\`. For all other types (numbers, booleans, arrays, objects), pass the value in JSON format and set \`string="false"\`.

If thinking_mode is enabled (triggered by {thinking_start_token}), you MUST output your complete reasoning inside {thinking_start_token}...{thinking_end_token} BEFORE any tool calls or final response.

Otherwise, output directly after {thinking_end_token} with tool calls or final response.

### Available Tool Schemas

{tool_schemas}

You MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.
`;

export type ThinkingMode = "chat" | "thinking";

export interface EncodeMessagesOptions {
  thinkingMode: ThinkingMode;
  dropThinking?: boolean;
  reasoningEffort?: "high" | "max";
}

function toolsFromOpenAiFormat(tools: ChatTool[]): ChatTool["function"][] {
  return tools.map((tool) => tool.function);
}

function toolCallsFromOpenAiFormat(toolCalls: ToolCall[]): Array<{ name: string; arguments: string | Record<string, unknown> }> {
  return toolCalls.map((toolCall) => ({
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
  }));
}

function encodeArgumentsToDsml(toolCall: { arguments: string | Record<string, unknown> }): string {
  const args = typeof toolCall.arguments === "string" ? JSON.parse(toolCall.arguments) : toolCall.arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("Tool call arguments must decode to a JSON object.");
  }

  return Object.entries(args)
    .map(([key, value]) => {
      const isString = typeof value === "string";
      const encodedValue = isString ? value : toJson(value);
      return `<${DSML_TOKEN}parameter name="${key}" string="${isString ? "true" : "false"}">${encodedValue}</${DSML_TOKEN}parameter>`;
    })
    .join("\n");
}

function renderTools(tools: ChatTool[]): string {
  return TOOLS_TEMPLATE.replaceAll("{tool_schemas}", toolsFromOpenAiFormat(tools).map((tool) => toJson(tool)).join("\n"))
    .replaceAll("{dsml_token}", DSML_TOKEN)
    .replaceAll("{thinking_start_token}", THINKING_START_TOKEN)
    .replaceAll("{thinking_end_token}", THINKING_END_TOKEN);
}

function findLastUserIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index]?.role;
    if (role === "user" || role === "developer") {
      return index;
    }
  }
  return -1;
}

function textFromContentBlocks(blocks: NonNullable<ChatMessage["content_blocks"]>): string {
  const parts = blocks.map((block) => {
    if (block.type === "text") {
      return block.text ?? "";
    }
    if (block.type === "tool_result") {
      const content = block.content;
      if (Array.isArray(content)) {
        return content
          .map((nested) => {
            if (typeof nested === "object" && nested !== null && "type" in nested && nested.type === "text" && "text" in nested) {
              return String(nested.text ?? "");
            }
            return "[Unsupported content block]";
          })
          .join("\n\n");
      }
      return `<tool_result>${String(content ?? "")}</tool_result>`;
    }
    return `[Unsupported ${block.type}]`;
  });
  return parts.join("\n\n");
}

function renderMessage(index: number, messages: ChatMessage[], options: Required<EncodeMessagesOptions>): string {
  const message = messages[index];
  if (!message) {
    throw new Error(`Message index ${index} is out of range.`);
  }

  let prompt = "";
  const lastUserIndex = findLastUserIndex(messages);
  const reasoning = message.reasoning ?? message.reasoning_content ?? "";
  const content = message.content ?? "";
  const tools = message.tools;
  const responseFormat = message.response_format;
  const toolCalls = message.tool_calls;
  const woEos = Boolean(message.prefix || message.wo_eos);

  if (index === 0 && options.thinkingMode === "thinking" && options.reasoningEffort === "max") {
    prompt += REASONING_EFFORT_MAX;
  }

  switch (message.role) {
    case "system": {
      prompt += content;
      if (tools) {
        prompt += `\n\n${renderTools(tools)}`;
      }
      if (responseFormat) {
        prompt += `\n\n## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n${toJson(responseFormat)}`;
      }
      break;
    }
    case "developer": {
      prompt += USER_SP_TOKEN + content;
      if (tools) {
        prompt += `\n\n${renderTools(tools)}`;
      }
      if (responseFormat) {
        prompt += `\n\n## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n${toJson(responseFormat)}`;
      }
      break;
    }
    case "user": {
      prompt += USER_SP_TOKEN;
      prompt += message.content_blocks ? textFromContentBlocks(message.content_blocks) : content;
      break;
    }
    case "latest_reminder": {
      prompt += LATEST_REMINDER_SP_TOKEN + content;
      break;
    }
    case "tool": {
      throw new Error("DeepSeek-V4 token counting expects tool result messages to be merged into user content_blocks.");
    }
    case "assistant": {
      let thinkingPart = "";
      let toolCallContent = "";
      if (toolCalls) {
        const renderedToolCalls = toolCallsFromOpenAiFormat(toolCalls).map((toolCall) => {
          return `<${DSML_TOKEN}invoke name="${toolCall.name}">\n${encodeArgumentsToDsml(toolCall)}\n</${DSML_TOKEN}invoke>`;
        });
        toolCallContent += `\n\n<${DSML_TOKEN}tool_calls>\n${renderedToolCalls.join("\n")}\n</${DSML_TOKEN}tool_calls>`;
      }
      const previousHasTask = index - 1 >= 0 && messages[index - 1]?.task !== undefined;
      if (options.thinkingMode === "thinking" && !previousHasTask) {
        thinkingPart = !options.dropThinking || index > lastUserIndex ? `${reasoning}${THINKING_END_TOKEN}` : "";
      }
      prompt += `${thinkingPart}${content}${toolCallContent}${woEos ? "" : EOS_TOKEN}`;
      break;
    }
    default: {
      const neverRole: never = message.role;
      throw new Error(`Unknown role: ${String(neverRole)}`);
    }
  }

  const nextRole = messages[index + 1]?.role;
  if (index + 1 < messages.length && nextRole !== "assistant" && nextRole !== "latest_reminder") {
    return prompt;
  }

  if (message.task !== undefined) {
    const token = DS_TASK_SP_TOKENS[message.task];
    if (!token) {
      throw new Error(`Invalid task ${JSON.stringify(message.task)}.`);
    }
    return `${prompt}${token}`;
  }

  if (options.thinkingMode === "chat") {
    return `${prompt}${ASSISTANT_SP_TOKEN}${THINKING_END_TOKEN}`;
  }
  return `${prompt}${ASSISTANT_SP_TOKEN}${THINKING_START_TOKEN}`;
}

export function encodeMessages(messages: ChatMessage[], options: EncodeMessagesOptions): string {
  if (messages.length === 0) {
    throw new Error("messages must not be empty.");
  }
  const normalizedOptions: Required<EncodeMessagesOptions> = {
    thinkingMode: options.thinkingMode,
    dropThinking: options.dropThinking ?? true,
    reasoningEffort: options.reasoningEffort ?? "high",
  };
  return BOS_TOKEN + messages.map((_, index) => renderMessage(index, messages, normalizedOptions)).join("");
}

