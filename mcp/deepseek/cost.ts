import { modelSpec, type DeepSeekModel } from "./models.js";
import type { DeepSeekUsage } from "./types.js";

const TOKENS_PER_MILLION = 1_000_000;

export interface CostPrices {
  inputCacheHitUsdPerMillion: number;
  inputCacheMissUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface CostEstimate {
  currency: "USD";
  model: DeepSeekModel;
  inputTokens: number;
  outputBudgetTokens: number;
  prices: CostPrices;
  inputCostIfAllCacheHitUsd: number;
  inputCostIfAllCacheMissUsd: number;
  outputBudgetCostUsd: number;
  totalIfAllInputCacheHitUsd: number;
  totalIfAllInputCacheMissUsd: number;
  human: {
    inputRange: string;
    outputBudget: string;
    totalRange: string;
  };
  assumptions: string[];
}

export interface ActualCost {
  currency: "USD";
  model: DeepSeekModel;
  promptTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  prices: CostPrices;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  human: {
    input: string;
    output: string;
    total: string;
  };
  assumptions: string[];
}

export interface TokenUsageCostEstimate {
  currency: "USD";
  model: DeepSeekModel;
  inputTokens: number;
  outputTokens: number;
  prices: CostPrices;
  inputCostIfAllCacheHitUsd: number;
  inputCostIfAllCacheMissUsd: number;
  outputCostUsd: number;
  totalIfAllInputCacheHitUsd: number;
  totalIfAllInputCacheMissUsd: number;
  human: {
    inputRange: string;
    output: string;
    totalRange: string;
  };
  assumptions: string[];
}

function pricesFor(model: DeepSeekModel): CostPrices {
  const spec = modelSpec(model);
  return {
    inputCacheHitUsdPerMillion: spec.cacheHitInputUsdPerMillion,
    inputCacheMissUsdPerMillion: spec.cacheMissInputUsdPerMillion,
    outputUsdPerMillion: spec.outputUsdPerMillion,
  };
}

function cost(tokens: number, usdPerMillion: number): number {
  return (tokens / TOKENS_PER_MILLION) * usdPerMillion;
}

function roundCost(value: number): number {
  return Number(value.toPrecision(12));
}

function formatUsd(value: number): string {
  if (value === 0) {
    return "$0";
  }
  if (value >= 0.01) {
    return `$${value.toFixed(4)}`;
  }
  if (value >= 0.0001) {
    return `$${value.toFixed(6)}`;
  }
  const fixed = value >= 0.000001 ? value.toFixed(9) : value.toFixed(12);
  return `$${fixed.replace(/0+$/u, "").replace(/\.$/u, "")}`;
}

export function estimateCost(model: DeepSeekModel, inputTokens: number, outputBudgetTokens: number): CostEstimate {
  const prices = pricesFor(model);
  const inputHit = roundCost(cost(inputTokens, prices.inputCacheHitUsdPerMillion));
  const inputMiss = roundCost(cost(inputTokens, prices.inputCacheMissUsdPerMillion));
  const outputBudget = roundCost(cost(outputBudgetTokens, prices.outputUsdPerMillion));
  const totalHit = roundCost(inputHit + outputBudget);
  const totalMiss = roundCost(inputMiss + outputBudget);

  return {
    currency: "USD",
    model,
    inputTokens,
    outputBudgetTokens,
    prices,
    inputCostIfAllCacheHitUsd: inputHit,
    inputCostIfAllCacheMissUsd: inputMiss,
    outputBudgetCostUsd: outputBudget,
    totalIfAllInputCacheHitUsd: totalHit,
    totalIfAllInputCacheMissUsd: totalMiss,
    human: {
      inputRange: `${formatUsd(inputHit)}-${formatUsd(inputMiss)} input`,
      outputBudget: `${formatUsd(outputBudget)} output budget`,
      totalRange: `${formatUsd(totalHit)}-${formatUsd(totalMiss)} worst-case total`,
    },
    assumptions: [
      "Preflight input cache status is unknown, so input cost is shown as an all-cache-hit to all-cache-miss range.",
      "Output cost is an upper bound based on the reserved/max output token budget; actual completion can be shorter.",
      "DeepSeek usage returned after sending is the final billing record.",
    ],
  };
}

export function estimateTokenUsageCost(model: DeepSeekModel, inputTokens: number, outputTokens: number): TokenUsageCostEstimate {
  const prices = pricesFor(model);
  const inputHit = roundCost(cost(inputTokens, prices.inputCacheHitUsdPerMillion));
  const inputMiss = roundCost(cost(inputTokens, prices.inputCacheMissUsdPerMillion));
  const output = roundCost(cost(outputTokens, prices.outputUsdPerMillion));
  const totalHit = roundCost(inputHit + output);
  const totalMiss = roundCost(inputMiss + output);

  return {
    currency: "USD",
    model,
    inputTokens,
    outputTokens,
    prices,
    inputCostIfAllCacheHitUsd: inputHit,
    inputCostIfAllCacheMissUsd: inputMiss,
    outputCostUsd: output,
    totalIfAllInputCacheHitUsd: totalHit,
    totalIfAllInputCacheMissUsd: totalMiss,
    human: {
      inputRange: `${formatUsd(inputHit)}-${formatUsd(inputMiss)} input`,
      output: `${formatUsd(output)} output`,
      totalRange: `${formatUsd(totalHit)}-${formatUsd(totalMiss)} total`,
    },
    assumptions: [
      "Input cache status is unknown from saved files, so input cost is shown as an all-cache-hit to all-cache-miss range.",
      "Response and reasoning file tokens are priced as DeepSeek output tokens.",
    ],
  };
}

export function costFromUsage(model: DeepSeekModel, usage: DeepSeekUsage): ActualCost {
  const prices = pricesFor(model);
  const promptTokens = Number(usage.prompt_tokens ?? 0);
  const promptCacheHitTokens = Number(usage.prompt_cache_hit_tokens ?? 0);
  const explicitMissTokens = usage.prompt_cache_miss_tokens;
  const promptCacheMissTokens =
    typeof explicitMissTokens === "number" ? explicitMissTokens : Math.max(0, promptTokens - promptCacheHitTokens);
  const completionTokens = Number(usage.completion_tokens ?? Math.max(0, Number(usage.total_tokens ?? 0) - promptTokens));
  const details = usage.completion_tokens_details;
  const reasoningTokens =
    typeof details === "object" && details !== null && !Array.isArray(details) && typeof details.reasoning_tokens === "number"
      ? details.reasoning_tokens
      : undefined;
  const inputCostUsd = roundCost(cost(promptCacheHitTokens, prices.inputCacheHitUsdPerMillion) + cost(promptCacheMissTokens, prices.inputCacheMissUsdPerMillion));
  const outputCostUsd = roundCost(cost(completionTokens, prices.outputUsdPerMillion));
  const totalCostUsd = roundCost(inputCostUsd + outputCostUsd);

  const assumptions: string[] = [];
  if (typeof explicitMissTokens !== "number") {
    assumptions.push("usage.prompt_cache_miss_tokens was absent; miss tokens were inferred as prompt_tokens - prompt_cache_hit_tokens.");
  }
  if (usage.completion_tokens === undefined) {
    assumptions.push("usage.completion_tokens was absent; completion tokens were inferred from total_tokens - prompt_tokens.");
  }

  return {
    currency: "USD",
    model,
    promptTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    completionTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    prices,
    inputCostUsd,
    outputCostUsd,
    totalCostUsd,
    human: {
      input: `${formatUsd(inputCostUsd)} input`,
      output: `${formatUsd(outputCostUsd)} output`,
      total: `${formatUsd(totalCostUsd)} total`,
    },
    assumptions,
  };
}
