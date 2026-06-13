import test from "node:test";
import assert from "node:assert/strict";
import { buildMcpDeepSeekLaunchSettings } from "../mcp/deepseek/launchSettings.js";
import { buildPayload, validatePayload } from "../mcp/deepseek/payload.js";
import type { RequestOptions } from "../mcp/deepseek/types.js";

test("MCP launch settings store requested and effective request settings without prompt text", () => {
  const prompt = "sensitive prompt text should stay in REQUEST.md";
  const requestedOptions: RequestOptions = {
    model: "deepseek-v4-pro",
    thinking: "enabled",
    reasoningEffort: "max",
    maxTokens: 4096,
    responseFormat: "json_object",
    temperature: 0.1,
    system: "sensitive system text should stay out of meta",
  };
  const effectiveOptions: RequestOptions = {
    ...requestedOptions,
    stream: true,
    includeUsage: true,
  };
  const payloadResult = buildPayload(prompt, effectiveOptions);
  const validationResult = validatePayload(payloadResult, { safetyMarginTokens: 200 });

  const settings = buildMcpDeepSeekLaunchSettings({
    source: "mcp-archived-request",
    requestedOptions,
    effectiveOptions,
    validationOptions: { safetyMarginTokens: 200 },
    validateBeforeSend: true,
    allowOversize: false,
    overwriteResponse: false,
    previewChars: 800,
    payloadResult,
    validationResult,
    transport: { stream: true },
  });

  assert.equal(settings.source, "mcp-archived-request");
  assert.equal(settings.requestedOptions.model, "deepseek-v4-pro");
  assert.equal(settings.requestedOptions.reasoning, "max");
  assert.equal(settings.requestedOptions.hasSystem, true);
  assert.equal(settings.effectiveOptions?.stream, true);
  assert.equal(settings.effectiveApiParameters.model, "deepseek-v4-pro");
  assert.deepEqual(settings.effectiveApiParameters.thinking, { type: "enabled" });
  assert.equal(settings.effectiveApiParameters.reasoning, "max");
  assert.equal(settings.validation?.options.safetyMarginTokens, 200);
  assert.equal(settings.validation?.result.model, "deepseek-v4-pro");
  assert.equal(settings.archive?.previewChars, 800);
  assert.doesNotMatch(JSON.stringify(settings), /sensitive prompt text|sensitive system text/);
});
