import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildPayload } from "../mcp/deepseek/payload.js";
import { countChatPromptTokens, countFimPromptTokens, JSON_OBJECT_RESPONSE_FORMAT_OVERHEAD_TOKENS } from "../mcp/deepseek/tokenCounter.js";
import { encodeText, resetTokenizerForTests } from "../mcp/deepseek/tokenizer.js";
import { encodeMessages } from "../mcp/deepseek/v4Encoding.js";
import type { ChatPayload, FimPayload } from "../mcp/deepseek/types.js";

test("DeepSeek tokenizer can load a Brotli-compressed tokenizer asset", () => {
  const oldTokenizerJson = process.env.DEEPSEEK_TOKENIZER_JSON;
  const oldTokenizerConfig = process.env.DEEPSEEK_TOKENIZER_CONFIG;
  try {
    process.env.DEEPSEEK_TOKENIZER_JSON = path.resolve("assets", "tokenizer.json.br");
    process.env.DEEPSEEK_TOKENIZER_CONFIG = path.resolve("assets", "tokenizer_config.json");
    resetTokenizerForTests();

    assert.deepEqual(encodeText("Hello!"), [19923, 3]);
  } finally {
    if (oldTokenizerJson === undefined) delete process.env.DEEPSEEK_TOKENIZER_JSON;
    else process.env.DEEPSEEK_TOKENIZER_JSON = oldTokenizerJson;
    if (oldTokenizerConfig === undefined) delete process.env.DEEPSEEK_TOKENIZER_CONFIG;
    else process.env.DEEPSEEK_TOKENIZER_CONFIG = oldTokenizerConfig;
    resetTokenizerForTests();
  }
});

test("DeepSeek tokenizer exposes official token ids", () => {
  assert.deepEqual(encodeText("Hello!"), [19923, 3]);
});

test("DeepSeek-V4 chat rendering matches calibrated small prompts", () => {
  const prompt = "Hello json";
  const high = buildPayload(prompt, { model: "deepseek-v4-pro", thinking: "enabled", reasoningEffort: "high" }).payload as ChatPayload;
  const max = buildPayload(prompt, { model: "deepseek-v4-pro", thinking: "enabled", reasoningEffort: "max" }).payload as ChatPayload;
  const disabled = buildPayload(prompt, { model: "deepseek-v4-pro", thinking: "disabled" }).payload as ChatPayload;

  assert.equal(countChatPromptTokens(high).tokens, 6);
  assert.equal(countChatPromptTokens(max).tokens, 85);
  assert.equal(countChatPromptTokens(disabled).tokens, 6);
  assert.equal(encodeMessages([{ role: "user", content: prompt }], { thinkingMode: "thinking", reasoningEffort: "high" }), "<｜begin▁of▁sentence｜><｜User｜>Hello json<｜Assistant｜><think>");
});

test("JSON mode applies the calibrated DeepSeek response_format overhead", () => {
  const prompt = "Hello json";
  const textPayload = buildPayload(prompt, { model: "deepseek-v4-pro", responseFormat: "text" }).payload as ChatPayload;
  const jsonPayload = buildPayload(prompt, { model: "deepseek-v4-pro", responseFormat: "json_object" }).payload as ChatPayload;

  assert.equal(countChatPromptTokens(jsonPayload).tokens - countChatPromptTokens(textPayload).tokens, JSON_OBJECT_RESPONSE_FORMAT_OVERHEAD_TOKENS);
});

test("FIM token preflight includes prefix/suffix marker overhead", () => {
  const hello = buildPayload("hello", { endpoint: "fim", model: "deepseek-v4-pro" }).payload as FimPayload;
  const fib = buildPayload("def fib(a):", { endpoint: "fim", model: "deepseek-v4-pro", suffix: "    return 1" }).payload as FimPayload;

  assert.equal(countFimPromptTokens(hello).tokens, 5);
  assert.equal(countFimPromptTokens(fib).tokens, 12);
});
