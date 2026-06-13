import { DEFAULT_BASE_URL } from "./client.js";

export interface DeepSeekBalanceInfo {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export interface DeepSeekAccountBalance {
  isAvailable: boolean;
  balanceInfos: DeepSeekBalanceInfo[];
}

export interface DeepSeekAccountBalanceOptions {
  apiKey?: string;
  baseUrl?: string;
}

export class DeepSeekAccountBalanceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "DeepSeekAccountBalanceError";
  }
}

function resolveApiKey(explicit: string | undefined): string {
  const key = explicit ?? process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new DeepSeekAccountBalanceError("DEEPSEEK_API_KEY is not set. Set it in the MCP process environment before reading account balance.", 503);
  }
  return key;
}

function balanceUrl(baseUrl: string | undefined): string {
  return `${(baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/u, "")}/user/balance`;
}

function stringField(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new DeepSeekAccountBalanceError(`DeepSeek balance response field ${fieldName} was not a string.`, 502);
  }
  return value;
}

function parseBalanceInfo(value: unknown): DeepSeekBalanceInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeepSeekAccountBalanceError("DeepSeek balance response included an invalid balance_infos item.", 502);
  }
  const record = value as Record<string, unknown>;
  return {
    currency: stringField(record.currency, "currency"),
    totalBalance: stringField(record.total_balance, "total_balance"),
    grantedBalance: stringField(record.granted_balance, "granted_balance"),
    toppedUpBalance: stringField(record.topped_up_balance, "topped_up_balance"),
  };
}

function parseAccountBalance(value: unknown): DeepSeekAccountBalance {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeepSeekAccountBalanceError("DeepSeek balance response was not a JSON object.", 502);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.is_available !== "boolean") {
    throw new DeepSeekAccountBalanceError("DeepSeek balance response field is_available was not a boolean.", 502);
  }
  if (!Array.isArray(record.balance_infos)) {
    throw new DeepSeekAccountBalanceError("DeepSeek balance response field balance_infos was not an array.", 502);
  }
  return {
    isAvailable: record.is_available,
    balanceInfos: record.balance_infos.map(parseBalanceInfo),
  };
}

export async function getDeepSeekAccountBalance(options: DeepSeekAccountBalanceOptions = {}): Promise<DeepSeekAccountBalance> {
  const response = await fetch(balanceUrl(options.baseUrl), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${resolveApiKey(options.apiKey)}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new DeepSeekAccountBalanceError(`DeepSeek balance HTTP ${response.status}: ${text}`, response.status);
  }
  try {
    return parseAccountBalance(JSON.parse(text));
  } catch (error) {
    if (error instanceof DeepSeekAccountBalanceError) {
      throw error;
    }
    throw new DeepSeekAccountBalanceError("DeepSeek balance response was not valid JSON.", 502);
  }
}
