import test from "node:test";
import assert from "node:assert/strict";
import { costFromUsage, estimateCost, estimateTokenUsageCost } from "../mcp/deepseek/cost.js";

test("preflight cost estimate reports cache-hit/cache-miss input range plus output budget", () => {
  const estimate = estimateCost("deepseek-v4-pro", 1_000_000, 100_000);

  assert.equal(estimate.inputCostIfAllCacheHitUsd, 0.003625);
  assert.equal(estimate.inputCostIfAllCacheMissUsd, 0.435);
  assert.equal(estimate.outputBudgetCostUsd, 0.087);
  assert.equal(estimate.totalIfAllInputCacheHitUsd, 0.090625);
  assert.equal(estimate.totalIfAllInputCacheMissUsd, 0.522);
  assert.match(estimate.human.totalRange, /\$0\.0906-\$0\.5220/);
});

test("actual cost uses DeepSeek usage cache split and completion tokens", () => {
  const actual = costFromUsage("deepseek-v4-flash", {
    prompt_tokens: 1000,
    prompt_cache_hit_tokens: 750,
    prompt_cache_miss_tokens: 250,
    completion_tokens: 500,
    total_tokens: 1500,
  });

  assert.equal(actual.inputCostUsd, 0.0000371);
  assert.equal(actual.outputCostUsd, 0.00014);
  assert.equal(actual.totalCostUsd, 0.0001771);
});

test("file token usage cost prices counted input and output tokens", () => {
  const estimate = estimateTokenUsageCost("deepseek-v4-flash", 1_000_000, 100_000);

  assert.equal(estimate.inputCostIfAllCacheHitUsd, 0.0028);
  assert.equal(estimate.inputCostIfAllCacheMissUsd, 0.14);
  assert.equal(estimate.outputCostUsd, 0.028);
  assert.equal(estimate.totalIfAllInputCacheHitUsd, 0.0308);
  assert.equal(estimate.totalIfAllInputCacheMissUsd, 0.168);
});
