import test from "node:test";
import assert from "node:assert/strict";
import { buildPayload, validatePayload } from "../mcp/deepseek/payload.js";
import type { ChatPayload } from "../mcp/deepseek/types.js";

test("legacy DeepSeek model aliases normalize to V4 model and thinking", () => {
  const result = buildPayload("hello", { model: "deepseek-chat", thinking: "omit" });
  const payload = result.payload as ChatPayload;

  assert.equal(payload.model, "deepseek-v4-flash");
  assert.deepEqual(payload.thinking, { type: "disabled" });
  assert.match(result.notes.join("\n"), /deprecated/);
});

test("FIM rejects models that the DeepSeek FIM API does not currently accept", () => {
  assert.throws(() => {
    buildPayload("hello", { endpoint: "fim", model: "deepseek-v4-flash" });
  }, /FIM beta currently supports deepseek-v4-pro only/);
});

test("validation reserves output and safety margin before accepting prompt fit", () => {
  const payload = buildPayload("hello", { model: "deepseek-v4-pro", maxTokens: 900 });
  const result = validatePayload(payload, { contextTokens: 1000, reserveOutputTokens: 950, safetyMarginTokens: 100 });

  assert.equal(result.status, "ERROR");
  assert.equal(result.fits, false);
  assert.match(result.reason, /Reserved output budget/);
  assert.equal(result.costEstimate.outputBudgetTokens, 950);
  assert.equal(result.costEstimate.model, "deepseek-v4-pro");
});
