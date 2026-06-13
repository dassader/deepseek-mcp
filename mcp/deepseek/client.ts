import { promises as fs } from "node:fs";
import type { BuildPayloadResult } from "./payload.js";
import type { DeepSeekPayload, DeepSeekUsage } from "./types.js";
import {
  appendReasoningText,
  appendResponseText,
  beginRequestSubmit,
  completeRequestSubmit,
  failRequestSubmit,
  touchRequestSubmitLease,
  type RequestPair,
} from "../archive/archive.js";
import type { DeepSeekLaunchSettings } from "./launchSettings.js";

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_BETA_BASE_URL = "https://api.deepseek.com/beta";

export interface SendOptions {
  apiKey?: string;
  baseUrl?: string;
  apiUrl?: string;
  stream?: boolean;
  progress?: (event: ProgressEvent) => void | Promise<void>;
}

export interface ProgressEvent {
  phase: "upload" | "download";
  uploadedBytes: number;
  uploadTotalBytes: number;
  uploadBytesPerSecond: number;
  reasoningBytes: number;
  responseBytes: number;
  reasoningDelta: string;
  responseDelta: string;
}

export interface SendResult {
  responseText: string;
  reasoningText?: string;
  usage?: DeepSeekUsage;
  responsePath?: string;
  reasoningPath?: string;
}

export class DeepSeekHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: string,
  ) {
    super(`DeepSeek HTTP ${statusCode}: ${body}`);
    this.name = "DeepSeekHttpError";
  }
}

function resolveApiKey(explicit: string | undefined): string {
  const key = explicit ?? process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new Error("DEEPSEEK_API_KEY is not set. The MCP server will not accept API keys in logs or saved files; set the environment variable for the process.");
  }
  return key;
}

export function endpointUrl(payloadResult: BuildPayloadResult, options: SendOptions = {}): string {
  if (options.apiUrl) {
    return options.apiUrl;
  }
  const payload = payloadResult.payload as DeepSeekPayload;
  const requestedBaseUrl = options.baseUrl ?? (typeof payload.base_url === "string" ? payload.base_url : undefined);
  const baseUrl = requestedBaseUrl ?? (payloadResult.endpoint === "fim" || hasAssistantPrefix(payload) ? DEFAULT_BETA_BASE_URL : DEFAULT_BASE_URL);
  const path = payloadResult.endpoint === "chat" ? "chat/completions" : "completions";
  return `${baseUrl.replace(/\/+$/u, "")}/${path}`;
}

function hasAssistantPrefix(payload: DeepSeekPayload): boolean {
  if (!("messages" in payload) || !Array.isArray(payload.messages)) {
    return false;
  }
  return payload.messages.some((message) => message.role === "assistant" && Boolean(message.prefix));
}

function extractUsage(value: unknown): DeepSeekUsage | undefined {
  if (typeof value === "object" && value !== null) {
    return value as DeepSeekUsage;
  }
  return undefined;
}

function extractChatDelta(event: Record<string, unknown>): { reasoning: string; content: string } {
  const choices = Array.isArray(event.choices) ? event.choices : [];
  const first = choices[0] as { delta?: Record<string, unknown> } | undefined;
  const delta = first?.delta ?? {};
  return {
    reasoning: typeof delta.reasoning_content === "string" ? delta.reasoning_content : "",
    content: typeof delta.content === "string" ? delta.content : "",
  };
}

function extractCompletionDelta(event: Record<string, unknown>): string {
  const choices = Array.isArray(event.choices) ? event.choices : [];
  const first = choices[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : "";
}

function uploadProgressEvent(uploadedBytes: number, uploadTotalBytes: number, startedAt: number): ProgressEvent {
  const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
  return {
    phase: "upload",
    uploadedBytes,
    uploadTotalBytes,
    uploadBytesPerSecond: Math.round(uploadedBytes / elapsedSeconds),
    reasoningBytes: 0,
    responseBytes: 0,
    reasoningDelta: "",
    responseDelta: "",
  };
}

function uploadBodyStream(body: Buffer, progress: NonNullable<SendOptions["progress"]>, startedAt: number): ReadableStream<Uint8Array> {
  const chunkSize = 64 * 1024;
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= body.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, body.length);
      const chunk = body.subarray(offset, end);
      offset = end;
      controller.enqueue(chunk);
      void Promise.resolve(progress(uploadProgressEvent(offset, body.length, startedAt))).catch(() => undefined);
    },
  });
}

async function postDeepSeek(url: string, apiKey: string, payload: DeepSeekPayload, accept?: string, progress?: SendOptions["progress"]): Promise<Response> {
  const bodyText = JSON.stringify(payload);
  const bodyBytes = Buffer.from(bodyText, "utf8");
  const uploadStartedAt = Date.now();
  await progress?.(uploadProgressEvent(0, bodyBytes.length, uploadStartedAt));
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(accept ? { Accept: accept } : {}),
    },
    body: progress ? uploadBodyStream(bodyBytes, progress, uploadStartedAt) : bodyText,
  };
  if (progress) {
    init.duplex = "half";
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new DeepSeekHttpError(response.status, body);
  }
  return response;
}

export async function sendDeepSeek(payloadResult: BuildPayloadResult, options: SendOptions = {}): Promise<SendResult> {
  const payload = { ...payloadResult.payload };
  const apiKey = resolveApiKey(options.apiKey);
  const url = endpointUrl(payloadResult, options);
  const stream = options.stream ?? Boolean(payload.stream);
  payload.stream = stream;
  if (!stream) {
    delete payload.stream_options;
  }
  return stream ? sendStream(url, apiKey, payloadResult.endpoint, payload, options.progress) : sendNonStream(url, apiKey, payloadResult.endpoint, payload);
}

async function sendNonStream(url: string, apiKey: string, endpoint: "chat" | "fim", payload: DeepSeekPayload): Promise<SendResult> {
  payload.stream = false;
  delete payload.stream_options;
  const response = await postDeepSeek(url, apiKey, payload);
  const body = (await response.json()) as Record<string, unknown>;
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const responseText =
    endpoint === "chat"
      ? String(((first?.message as Record<string, unknown> | undefined)?.content as string | undefined) ?? "")
      : String((first?.text as string | undefined) ?? "");
  const reasoningText =
    endpoint === "chat" ? String(((first?.message as Record<string, unknown> | undefined)?.reasoning_content as string | undefined) ?? "") : "";
  const usage = extractUsage(body.usage);
  return { responseText, ...(reasoningText ? { reasoningText } : {}), ...(usage ? { usage } : {}) };
}

async function sendStream(
  url: string,
  apiKey: string,
  endpoint: "chat" | "fim",
  payload: DeepSeekPayload,
  progress: SendOptions["progress"],
): Promise<SendResult> {
  payload.stream = true;
  if (payload.stream_options === undefined) {
    payload.stream_options = { include_usage: true };
  }
  const response = await postDeepSeek(url, apiKey, payload, "text/event-stream", progress);
  if (!response.body) {
    throw new Error("DeepSeek streaming response did not include a body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseText = "";
  let reasoningText = "";
  let reasoningBytes = 0;
  let responseBytes = 0;
  let usage: DeepSeekUsage | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) {
        continue;
      }
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        await progress?.({
          phase: "download",
          uploadedBytes: 0,
          uploadTotalBytes: 0,
          uploadBytesPerSecond: 0,
          reasoningBytes,
          responseBytes,
          reasoningDelta: "",
          responseDelta: "",
        });
        return { responseText, ...(reasoningText ? { reasoningText } : {}), ...(usage ? { usage } : {}) };
      }
      const event = JSON.parse(data) as Record<string, unknown>;
      usage = extractUsage(event.usage) ?? usage;
      let reasoningDelta = "";
      let responseDelta = "";
      if (endpoint === "chat") {
        const delta = extractChatDelta(event);
        reasoningDelta = delta.reasoning;
        responseDelta = delta.content;
        reasoningText += reasoningDelta;
        reasoningBytes += Buffer.byteLength(reasoningDelta, "utf8");
        responseText += responseDelta;
      } else {
        responseDelta = extractCompletionDelta(event);
        responseText += responseDelta;
      }
      responseBytes += Buffer.byteLength(responseDelta, "utf8");
      await progress?.({
        phase: "download",
        uploadedBytes: 0,
        uploadTotalBytes: 0,
        uploadBytesPerSecond: 0,
        reasoningBytes,
        responseBytes,
        reasoningDelta,
        responseDelta,
      });
    }
  }
  return { responseText, ...(reasoningText ? { reasoningText } : {}), ...(usage ? { usage } : {}) };
}

export async function sendAndArchive(
  payloadResult: BuildPayloadResult,
  pair: RequestPair,
  launchSettings: DeepSeekLaunchSettings,
  options: SendOptions = {},
): Promise<SendResult> {
  await beginRequestSubmit(pair, launchSettings);
  const stream = options.stream ?? Boolean((payloadResult.payload as DeepSeekPayload).stream);
  const heartbeat = setInterval(() => {
    void touchRequestSubmitLease(pair).catch(() => undefined);
  }, 5000);
  try {
    const result = await sendDeepSeek(payloadResult, {
      ...options,
      progress: async (progress) => {
        await touchRequestSubmitLease(pair);
        if (progress.phase === "download") {
          await appendReasoningText(pair, progress.reasoningDelta);
          await appendResponseText(pair, progress.responseDelta);
        }
        await options.progress?.(progress);
      },
    });
    if (!stream) {
      await fs.writeFile(pair.responsePath, result.responseText, "utf8");
      await fs.writeFile(pair.reasoningPath, result.reasoningText ?? "", "utf8");
    }
    await completeRequestSubmit(pair);
    return {
      ...result,
      responsePath: pair.responsePath,
      reasoningPath: pair.reasoningPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = error instanceof DeepSeekHttpError ? error.statusCode : undefined;
    await failRequestSubmit(pair, message, statusCode);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
