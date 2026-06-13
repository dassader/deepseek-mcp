import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ErrorCode, McpError, type ServerNotification, type ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import {
  archiveRequest,
  createRequestFile,
  dataDir as configuredDataDir,
  listRequests,
  publicRequest,
  readReasoningResource,
  readRequestResource,
  readRequestText,
  readResponseResource,
  requestVersions,
  resolveActiveRequestPair,
  updateRequestContent,
  RequestStoreError,
  appendRequestContent,
  type RequestPair,
  type RequestVersionStatus,
} from "./archive/archive.js";
import { appendRequestZip } from "./archive/zipAppend.js";
import { DeepSeekAccountBalanceError, getDeepSeekAccountBalance } from "./deepseek/balance.js";
import { sendAndArchive, type ProgressEvent } from "./deepseek/client.js";
import { costFromUsage } from "./deepseek/cost.js";
import { buildMcpDeepSeekLaunchSettings } from "./deepseek/launchSettings.js";
import { DEEPSEEK_MODELS, MODEL_SPECS } from "./deepseek/models.js";
import { DEFAULT_CHAT_MAX_TOKENS, buildPayload, validatePayload } from "./deepseek/payload.js";
import type { RequestOptions } from "./deepseek/types.js";
import { describeMcpHttp, mcpHttpConfigFromEnv } from "./http/mcpHttpConfig.js";
import { stringifyPretty } from "./shared/json.js";

const SERVER_VERSION = "0.1.0";

const modelSchema = z.enum(["deepseek-v4-flash", "deepseek-v4-pro"]);
const submitThinkingSchema = z.enum(["enabled", "disabled"]);
const reasoningEffortSchema = z.enum(["high", "max"]);
const responseFormatSchema = z.enum(["text", "json_object"]);
const requestIdSchema = z.string().min(1).describe("Request id. This is the active folder name under requests/{id}. Archived requests are not exposed through MCP reads/lists.");
const requestTitleSchema = z
  .string()
  .trim()
  .min(3)
  .max(160)
  .describe("Required short title: what or why the agent is asking DeepSeek.");
const requestStatusSchema = z.enum(["draft", "pending", "filling", "filled", "error"]);

const requestSubmitCommonInputSchema = {
  progressInterval: z
    .number()
    .int()
    .min(0)
    .default(10)
    .describe("Seconds between progress notifications. Use 0 to disable progress messages. Default: 10."),
  model: modelSchema.default("deepseek-v4-pro").describe("DeepSeek API model. Use deepseek-v4-pro for hardest coding/reasoning; deepseek-v4-flash for cheaper/faster normal work."),
  thinking: submitThinkingSchema
    .default("enabled")
    .describe("DeepSeek API thinking.type. enabled returns reasoning_content before the final answer; disabled asks the model to answer without thinking mode."),
  reasoning: reasoningEffortSchema
    .default("high")
    .describe("DeepSeek API reasoning_effort. high is the normal default; max spends more reasoning effort for complex agent/coding tasks."),
  responseFormat: responseFormatSchema
    .default("text")
    .describe("DeepSeek API response_format.type. Use text for normal answers; use json_object only when the request content explicitly instructs the model to output valid JSON."),
  maxTokens: z
    .number()
    .int()
    .min(1)
    .max(DEFAULT_CHAT_MAX_TOKENS)
    .default(DEFAULT_CHAT_MAX_TOKENS)
    .describe("DeepSeek API max_tokens. Default is the model maximum, 384000, so the backend does not accidentally cap long responses."),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .default(1)
    .describe("DeepSeek API temperature from 0 to 2. Use 0-0.2 for deterministic code/review; use the default 1 for normal model behavior."),
  reserveOutputTokens: z
    .number()
    .int()
    .min(0)
    .max(DEFAULT_CHAT_MAX_TOKENS)
    .optional()
    .describe("Preflight validation output budget. Defaults to maxTokens. Used for token fit and estimated cost before the API call."),
  safetyMarginTokens: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Extra preflight context margin. Defaults to backend safety margin: max(100, 0.1% of context)."),
};

const requestSubmitInputSchema = {
  id: requestIdSchema.describe("Required request id. Submit sends the current active request version and returns the DeepSeek answer saved to response/reasoning files."),
  ...requestSubmitCommonInputSchema,
};

const requestSubmitBatchInputSchema = {
  ids: z
    .array(requestIdSchema)
    .min(1)
    .max(16)
    .describe("Request ids to submit in parallel. Duplicate ids are rejected because one request version cannot be written by two sends at the same time."),
  ...requestSubmitCommonInputSchema,
};

const outputShape = {
  ok: z.boolean(),
  agentExplanation: z.string(),
  data: z.unknown(),
};

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolResult = ReturnType<typeof textResult>;
type SubmitModel = z.infer<typeof modelSchema>;
type SubmitThinking = z.infer<typeof submitThinkingSchema>;
type SubmitReasoning = z.infer<typeof reasoningEffortSchema>;
type SubmitResponseFormat = z.infer<typeof responseFormatSchema>;

interface SubmitRequestInput {
  id: string;
  progressInterval: number;
  model: SubmitModel;
  thinking: SubmitThinking;
  reasoning: SubmitReasoning;
  responseFormat: SubmitResponseFormat;
  maxTokens: number;
  temperature: number;
  reserveOutputTokens?: number;
  safetyMarginTokens?: number;
}

interface PreparedSubmit {
  pair: RequestPair;
  promptText: string;
  requestedOptions: RequestOptions;
  sendOptions: RequestOptions;
  payloadResult: ReturnType<typeof buildPayload>;
  validationOptions: ReturnType<typeof cleanValidationOptions>;
  validationResult: ReturnType<typeof validatePayload>;
  preflightSummary: string;
  transport: ReturnType<typeof cleanTransportOptions>;
  launchSettings: ReturnType<typeof buildMcpDeepSeekLaunchSettings>;
}

interface SubmittedRequestData {
  statusCode: number;
  request: unknown;
  response: unknown;
  reasoning: unknown;
  validation: ReturnType<typeof validatePayload>;
  usage: unknown;
  actualCost: ReturnType<typeof costFromUsage> | undefined;
  preflightCost: ReturnType<typeof validatePayload>["costEstimate"];
  message: string;
}

interface BatchRequestState {
  id: string;
  version?: number;
  status: "active" | "finished" | "error";
  reasoningBytes: number;
  responseBytes: number;
  error?: string;
  data?: SubmittedRequestData;
}

function textResult(summary: string, structuredContent: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${summary}\n\n${stringifyPretty(structuredContent)}`,
      },
    ],
    structuredContent,
  };
}

function toolFailure(error: unknown): ToolResult & { isError: true } {
  const statusCode = error instanceof RequestStoreError || error instanceof DeepSeekAccountBalanceError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : String(error);
  return {
    ...textResult(message, {
      ok: false,
      agentExplanation: message,
      data: { statusCode },
    }),
    isError: true,
  };
}

async function handled(action: () => Promise<ToolResult>): Promise<ToolResult | (ToolResult & { isError: true })> {
  try {
    return await action();
  } catch (error) {
    return toolFailure(error);
  }
}

function mcpResourceError(error: unknown): never {
  if (error instanceof RequestStoreError || error instanceof DeepSeekAccountBalanceError) {
    throw new McpError(ErrorCode.InvalidParams, error.message, { statusCode: error.statusCode });
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new McpError(ErrorCode.InternalError, message);
}

function capabilities() {
  const mcpHttpConfig = mcpHttpConfigFromEnv();
  return {
    server: {
      name: "deepseek-v4-mcp",
      version: SERVER_VERSION,
      transport: "stdio plus optional MCP Streamable HTTP",
      sdk: "@modelcontextprotocol/sdk v1.x high-level McpServer API",
    },
    environment: {
      apiKeySource: "DEEPSEEK_API_KEY process environment",
      requiresProcessApiKey: true,
      dataDir: configuredDataDir(),
      activeRequestsDir: `${configuredDataDir()}/requests`,
      archivedRequestsDir: `${configuredDataDir()}/archive`,
      requestCreationIndexDir: `${configuredDataDir()}/index/requests`,
      deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      deepseekBetaBaseUrl: process.env.DEEPSEEK_BETA_BASE_URL ?? "https://api.deepseek.com/beta",
    },
    requestModel: {
      id: "The request id is the request folder name. request, response, and reasoning share the same id.",
      layout: [
        "requests/{id}/meta.json",
        "requests/{id}/versions/{version}/REQUEST.md",
        "requests/{id}/versions/{version}/request.json",
        "requests/{id}/versions/{version}/RESPONSE.md",
        "requests/{id}/versions/{version}/response.json",
        "requests/{id}/versions/{version}/REASONING.md",
        "requests/{id}/versions/{version}/reasoning.json",
        "archive/{id}/... mirrors requests/{id}/... after request_archive",
        "index/requests/{YYYY-MM-DD_HH} contains one request id per line for requests created during that UTC hour",
      ],
      immutableRequestVersions: true,
      canonicalReadResources: ["deepseek://request/{id}{?version}", "deepseek://response/{id}{?version}", "deepseek://reasoning/{id}{?version}"],
      mutatingTools: ["request_create", "request_update", "request_append", "request_append_zip", "request_archive", "request_submit", "request_batch"],
      readTools: ["request_list", "request_versions", "request_read", "response_read", "reasoning_read"],
      requestListFilters: {
        after: "Filter by request updated time.",
        before: "Filter by request updated time.",
        createdAfter: "Filter by request creation time and use the hourly creation index for fast recent windows.",
        createdBefore: "Optional upper creation-time bound for hourly indexed reads.",
      },
      resources: ["request", "response", "reasoning", "models", "instructions", "account_balance"],
      archivedRequests: "Archived request trees are stored under data/archive but are not exposed through MCP read/list APIs.",
      requestSubmitParameters: {
        required: ["id"],
        model: ["deepseek-v4-flash", "deepseek-v4-pro"],
        thinking: ["enabled", "disabled"],
        reasoning: ["high", "max"],
        responseFormat: ["text", "json_object"],
        maxTokensDefault: DEFAULT_CHAT_MAX_TOKENS,
        validation: "request_submit counts tokens and estimated cost locally before the API call. If submit is called and the prompt fits, the server sends it to DeepSeek and saves the answer.",
      },
      requestBatchParameters: {
        required: ["ids"],
        ids: "Active request ids submitted concurrently. Duplicate ids are rejected because each request version owns one response/reasoning file pair.",
        launchParameters: ["progressInterval", "model", "thinking", "reasoning", "responseFormat", "maxTokens", "temperature", "reserveOutputTokens", "safetyMarginTokens"],
        progressLog:
          "One aggregate MCP logging message per tick: \"12s Batch: 4 Active: 3 Finished: 1 Error: 0 Reasoning: 17472 Response: 46363\".",
        finalResult: "Returns per-request ok/status/error plus request/response/reasoning metadata; response text is read separately through response_read.",
      },
    },
    mcpHttp: describeMcpHttp(mcpHttpConfig, mcpHttpConfig.enabled),
    models: DEEPSEEK_MODELS.map((model) => MODEL_SPECS[model]),
  };
}

function requestSubmitPreflightSummary(result: ReturnType<typeof validatePayload>): string {
  return [
    `Preflight validation: ${result.status}.`,
    `model=${result.model}`,
    `input_tokens=${result.inputTokens}`,
    `reserve_output_tokens=${result.reservedOutputTokens}`,
    `safety_margin_tokens=${result.safetyMarginTokens}`,
    `headroom_tokens=${result.headroomTokens}`,
    `estimated_cost=${result.costEstimate.human.totalRange}`,
  ].join(" ");
}

function requestOptionsWithSubmitDefaults(options: RequestOptions | undefined): RequestOptions {
  return {
    ...(options ?? {}),
    stream: options?.stream ?? true,
    includeUsage: options?.includeUsage ?? true,
  } as RequestOptions;
}

function cleanValidationOptions(
  value:
    | {
        contextTokens?: number | undefined;
        reserveOutputTokens?: number | undefined;
        safetyMarginTokens?: number | undefined;
      }
    | undefined,
) {
  if (!value) {
    return undefined;
  }
  return {
    ...(value.contextTokens !== undefined ? { contextTokens: value.contextTokens } : {}),
    ...(value.reserveOutputTokens !== undefined ? { reserveOutputTokens: value.reserveOutputTokens } : {}),
    ...(value.safetyMarginTokens !== undefined ? { safetyMarginTokens: value.safetyMarginTokens } : {}),
  };
}

function cleanTransportOptions(options: RequestOptions) {
  return {
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.apiUrl !== undefined ? { apiUrl: options.apiUrl } : {}),
    ...(options.stream !== undefined ? { stream: options.stream } : {}),
  };
}

function versionFromUri(uri: URL): number | undefined {
  const value = uri.searchParams.get("version");
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RequestStoreError(`Invalid request version: ${value}`, 400);
  }
  return version;
}

function idFromVariables(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

async function requestResourceContents(uri: URL, id: string) {
  const pair = await resolveActiveRequestPair(id, undefined, versionFromUri(uri));
  const result = await readRequestResource(pair.id, undefined, pair.version);
  return {
    contents: [{ uri: uri.href, mimeType: "application/json", text: stringifyPretty(result) }],
  };
}

async function responseResourceContents(uri: URL, id: string) {
  const pair = await resolveActiveRequestPair(id, undefined, versionFromUri(uri));
  const result = await readResponseResource(pair.id, undefined, pair.version);
  return {
    contents: [{ uri: uri.href, mimeType: "application/json", text: stringifyPretty(result) }],
  };
}

async function reasoningResourceContents(uri: URL, id: string) {
  const pair = await resolveActiveRequestPair(id, undefined, versionFromUri(uri));
  const result = await readReasoningResource(pair.id, undefined, pair.version);
  return {
    contents: [{ uri: uri.href, mimeType: "application/json", text: stringifyPretty(result) }],
  };
}

async function requestResourceList() {
  const requests = await listRequests();
  return {
    resources: requests.map((request) => ({
      uri: `deepseek://request/${request.id}`,
      name: request.id,
      title: request.title,
      mimeType: "application/json",
    })),
  };
}

async function responseResourceList() {
  const requests = await listRequests();
  return {
    resources: requests
      .filter((request) => request.hasResponse)
      .map((request) => ({
        uri: `deepseek://response/${request.id}`,
        name: request.id,
        title: request.title,
        mimeType: "application/json",
      })),
  };
}

async function reasoningResourceList() {
  const requests = await listRequests();
  return {
    resources: requests
      .filter((request) => request.hasReasoning)
      .map((request) => ({
        uri: `deepseek://reasoning/${request.id}`,
        name: request.id,
        title: request.title,
        mimeType: "application/json",
      })),
  };
}

function secondsSince(startedAt: number): number {
  return Math.floor((Date.now() - startedAt) / 1000);
}

async function sendSubmitStartLog(
  server: McpServer,
  extra: ToolExtra,
  input: {
    pair: RequestPair;
    progressInterval: number;
    promptText: string;
    payloadResult: ReturnType<typeof buildPayload>;
    validationResult: ReturnType<typeof validatePayload>;
    requestedOptions: RequestOptions;
    sendOptions: RequestOptions;
  },
): Promise<void> {
  try {
    const payload = input.payloadResult.payload;
    const promptBytes = Buffer.byteLength(input.promptText, "utf8");
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const cost = input.validationResult.costEstimate;
    await server.sendLoggingMessage(
      {
        level: "info",
        logger: "request_submit",
        data:
          `request_id=${input.pair.id} version=${input.pair.version} phase=start ` +
          `endpoint=${input.payloadResult.endpoint} model=${payload.model} thinking=${"thinking" in input.requestedOptions ? input.requestedOptions.thinking ?? "default" : "n/a"} ` +
          `reasoning=${"reasoningEffort" in input.requestedOptions ? input.requestedOptions.reasoningEffort ?? "default" : "n/a"} ` +
          `response_format=${"responseFormat" in input.requestedOptions ? input.requestedOptions.responseFormat ?? "text" : "n/a"} ` +
          `max_tokens=${payload.max_tokens ?? "none"} temperature=${payload.temperature ?? "default"} stream=${input.sendOptions.stream === true} ` +
          `include_usage=${input.sendOptions.includeUsage === true} progress_interval_seconds=${input.progressInterval} ` +
          `prompt_bytes=${promptBytes} payload_bytes=${payloadBytes} input_tokens=${input.validationResult.inputTokens} ` +
          `reserve_output_tokens=${input.validationResult.reservedOutputTokens} safety_margin_tokens=${input.validationResult.safetyMarginTokens} ` +
          `headroom_tokens=${input.validationResult.headroomTokens} estimated_cost_cache_hit_usd=${cost.totalIfAllInputCacheHitUsd} ` +
          `estimated_cost_cache_miss_usd=${cost.totalIfAllInputCacheMissUsd}`,
      },
      extra.sessionId,
    );
  } catch {
    // Submit logs are best-effort.
  }
}

async function sendSubmitProgressLog(server: McpServer, extra: ToolExtra, pair: RequestPair, progress: ProgressEvent, startedAt: number): Promise<void> {
  try {
    const elapsedSeconds = secondsSince(startedAt);
    const data =
      progress.phase === "upload"
        ? `request_id=${pair.id} version=${pair.version} sending elapsed_seconds=${elapsedSeconds} uploaded_bytes=${progress.uploadedBytes} upload_total_bytes=${progress.uploadTotalBytes} upload_bytes_per_second=${progress.uploadBytesPerSecond}`
        : `request_id=${pair.id} version=${pair.version} progress elapsed_seconds=${elapsedSeconds} reasoning_bytes=${progress.reasoningBytes} response_bytes=${progress.responseBytes}`;
    await server.sendLoggingMessage(
      {
        level: "info",
        logger: "request_submit",
        data,
      },
      extra.sessionId,
    );
  } catch {
    // Submit logs are best-effort.
  }
}

async function prepareSubmit(input: SubmitRequestInput): Promise<PreparedSubmit> {
  const pair = await resolveActiveRequestPair(input.id);
  const promptText = await readRequestText(pair);
  const requestedOptions: RequestOptions = {
    model: input.model,
    thinking: input.thinking,
    reasoningEffort: input.reasoning,
    responseFormat: input.responseFormat,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
  };
  const sendOptions = requestOptionsWithSubmitDefaults(requestedOptions);
  const payloadResult = buildPayload(promptText, sendOptions);
  const validationOptions = cleanValidationOptions({
    ...(input.reserveOutputTokens !== undefined ? { reserveOutputTokens: input.reserveOutputTokens } : {}),
    ...(input.safetyMarginTokens !== undefined ? { safetyMarginTokens: input.safetyMarginTokens } : {}),
  });
  const validationResult = validatePayload(payloadResult, validationOptions);
  const preflightSummary = requestSubmitPreflightSummary(validationResult);
  if (!validationResult.fits) {
    throw new RequestStoreError(`${preflightSummary} Refusing to send: ${validationResult.reason}`, 409);
  }

  const transport = cleanTransportOptions(sendOptions);
  const launchSettings = buildMcpDeepSeekLaunchSettings({
    source: "mcp-archived-request",
    requestedOptions,
    effectiveOptions: sendOptions,
    validationOptions,
    validateBeforeSend: true,
    allowOversize: false,
    overwriteResponse: false,
    previewChars: 800,
    payloadResult,
    validationResult,
    transport: { ...transport, progressInterval: input.progressInterval },
  });

  return {
    pair,
    promptText,
    requestedOptions,
    sendOptions,
    payloadResult,
    validationOptions,
    validationResult,
    preflightSummary,
    transport,
    launchSettings,
  };
}

async function executePreparedSubmit(prepared: PreparedSubmit, progress?: (event: ProgressEvent) => void | Promise<void>): Promise<SubmittedRequestData> {
  const result = await sendAndArchive(prepared.payloadResult, prepared.pair, prepared.launchSettings, {
    ...prepared.transport,
    ...(progress !== undefined ? { progress } : {}),
  });
  const actualCost = result.usage ? costFromUsage(prepared.payloadResult.payload.model, result.usage) : undefined;
  const response = await readResponseResource(prepared.pair.id, undefined, prepared.pair.version);
  const reasoningResource = await readReasoningResource(prepared.pair.id, undefined, prepared.pair.version);
  const request = await readRequestResource(prepared.pair.id, undefined, prepared.pair.version);
  return {
    statusCode: 200,
    request: request.request,
    response: response.response,
    reasoning: reasoningResource.reasoning,
    validation: prepared.validationResult,
    usage: result.usage,
    actualCost,
    preflightCost: prepared.validationResult.costEstimate,
    message: "DeepSeek completed the request successfully.",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function batchCounts(states: BatchRequestState[]) {
  return {
    total: states.length,
    active: states.filter((state) => state.status === "active").length,
    finished: states.filter((state) => state.status === "finished").length,
    error: states.filter((state) => state.status === "error").length,
    reasoningBytes: states.reduce((sum, state) => sum + state.reasoningBytes, 0),
    responseBytes: states.reduce((sum, state) => sum + state.responseBytes, 0),
  };
}

function batchProgressLine(states: BatchRequestState[], startedAt: number): string {
  const counts = batchCounts(states);
  return (
    `${secondsSince(startedAt)}s ` +
    `Batch: ${counts.total} Active: ${counts.active} Finished: ${counts.finished} Error: ${counts.error} ` +
    `Reasoning: ${counts.reasoningBytes} Response: ${counts.responseBytes}`
  );
}

async function sendBatchProgressLog(server: McpServer, extra: ToolExtra, states: BatchRequestState[], startedAt: number): Promise<void> {
  try {
    await server.sendLoggingMessage(
      {
        level: "info",
        logger: "request_batch",
        data: batchProgressLine(states, startedAt),
      },
      extra.sessionId,
    );
  } catch {
    // Batch logs are best-effort.
  }
}

async function sendBatchResultLog(server: McpServer, extra: ToolExtra, states: BatchRequestState[]): Promise<void> {
  try {
    const results = states
      .map((state) => `${state.id} version=${state.version ?? "n/a"} status=${state.status}${state.error ? ` error=${JSON.stringify(state.error)}` : ""}`)
      .join("; ");
    await server.sendLoggingMessage(
      {
        level: states.some((state) => state.status === "error") ? "warning" : "info",
        logger: "request_batch",
        data: `Batch results: ${results}`,
      },
      extra.sessionId,
    );
  } catch {
    // Batch logs are best-effort.
  }
}

function assertUniqueBatchIds(ids: string[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  }
  if (duplicates.size > 0) {
    throw new RequestStoreError(`request_batch does not accept duplicate ids: ${[...duplicates].join(", ")}`, 400);
  }
}

function submitInputForId(id: string, input: Omit<SubmitRequestInput, "id">): SubmitRequestInput {
  return {
    id,
    progressInterval: input.progressInterval,
    model: input.model,
    thinking: input.thinking,
    reasoning: input.reasoning,
    responseFormat: input.responseFormat,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    ...(input.reserveOutputTokens !== undefined ? { reserveOutputTokens: input.reserveOutputTokens } : {}),
    ...(input.safetyMarginTokens !== undefined ? { safetyMarginTokens: input.safetyMarginTokens } : {}),
  };
}

export function createDeepSeekMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "deepseek-v4-mcp",
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        logging: {},
        resources: {},
        tools: {},
        prompts: {},
      },
    },
  );

  server.registerTool(
    "capabilities",
    {
      title: "Capabilities",
      description: "Return this server's models, request store layout, canonical resources, tools, and transport metadata.",
      inputSchema: {},
      outputSchema: outputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      handled(async () =>
        textResult("MCP capabilities loaded.", {
          ok: true,
          agentExplanation: "Use this as the source of truth before choosing a model, endpoint, or request workflow.",
          data: capabilities(),
        }),
      ),
  );

  server.registerTool(
    "request_create",
    {
      title: "Create Request",
      description: "Create requests/{id}/meta.json plus versions/0/REQUEST.md and request.json. Version 0 starts empty and draft.",
      inputSchema: {
        title: requestTitleSchema,
      },
      outputSchema: outputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title }) =>
      handled(async () => {
        const pair = await createRequestFile(title);
        const result = await readRequestResource(pair.id, undefined, 0);
        return textResult(`Created request ${pair.id}.`, {
          ok: true,
          agentExplanation: "The request exists with an empty draft version 0. Use request_update to create a content version.",
          data: result.request,
        });
      }),
  );

  server.registerTool(
    "request_update",
    {
      title: "Update Request",
      description: "Create the next immutable request version with new REQUEST.md content. Existing versions are never changed.",
      inputSchema: {
        id: requestIdSchema,
        content: z.string(),
      },
      outputSchema: outputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, content }) =>
      handled(async () => {
        const request = await updateRequestContent(id, content);
        return textResult(`Created request ${id} version ${request.version}.`, {
          ok: true,
          agentExplanation: "A new draft version was created. Older REQUEST.md files were not changed.",
          data: request,
        });
      }),
  );

  server.registerTool(
    "request_append",
    {
      title: "Append Request Content",
      description:
        "Append text to the end of the current active draft REQUEST.md while assembling a prompt. If the current version already finished or errored, create the next draft version first and write the content there.",
      inputSchema: {
        id: requestIdSchema,
        content: z
          .string()
          .describe("Text to append exactly as provided. Include leading or trailing newlines when you want separation between prompt sections."),
      },
      outputSchema: outputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, content }) =>
      handled(async () => {
        const result = await appendRequestContent(id, content);
        return textResult(
          result.createdVersion
            ? `Created request ${id} version ${result.version} and wrote appended content there.`
            : `Appended to request ${id} version ${result.version}.`,
          {
            ok: true,
            agentExplanation: result.createdVersion
              ? "The previous current version was no longer draft, so a new draft version was created and initialized with the provided content."
              : "Content was appended to the current draft version. No new version was created.",
            data: result.request,
          },
        );
      }),
  );

  server.registerTool(
    "request_append_zip",
    {
      title: "Append ZIP Files To Request",
      description:
        "Append every UTF-8 text file from a ZIP archive to the current active request. Use this when an agent needs to add many project files without manually walking the tree. The tool writes each file as: relative/path, then a blank line, then that file's content; files are appended in sorted relative-path order for deterministic prompts. Create the ZIP with only relevant source/config/test files and exclude build outputs, dependencies, secrets, images, and other binary assets.",
      inputSchema: {
        id: requestIdSchema,
        zipPath: z
          .string()
          .optional()
          .describe("Server-local path to a .zip file. Use this when the MCP server and agent share the same filesystem. Provide exactly one of zipPath or zipBase64."),
        zipBase64: z
          .string()
          .optional()
          .describe("Base64-encoded ZIP bytes. Use this for remote MCP HTTP clients that cannot rely on a server-local file path. Provide exactly one of zipPath or zipBase64."),
        binaryPolicy: z
          .enum(["reject", "skip"])
          .default("reject")
          .describe("How to handle non-UTF-8 or binary files in the archive. reject fails loudly so the agent can rebuild a clean prompt archive; skip appends text files and reports skipped paths."),
      },
      outputSchema: outputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, zipPath, zipBase64, binaryPolicy }) =>
      handled(async () => {
        const result = await appendRequestZip(id, {
          ...(zipPath !== undefined ? { zipPath } : {}),
          ...(zipBase64 !== undefined ? { zipBase64 } : {}),
          ...(binaryPolicy !== undefined ? { binaryPolicy } : {}),
        });
        const skipped = result.skippedFiles.length > 0 ? ` Skipped ${result.skippedFiles.length} binary/non-text file${result.skippedFiles.length === 1 ? "" : "s"}.` : "";
        return textResult(`Appended ${result.files.length} ZIP file${result.files.length === 1 ? "" : "s"} to request ${id} version ${result.version}.${skipped}`, {
          ok: true,
          agentExplanation:
            "The ZIP was expanded into deterministic file blocks. Each block starts with the relative path, then a blank line, then UTF-8 file content. Use request_read to inspect the final prompt before submitting.",
          data: result,
        });
      }),
  );

  server.registerTool(
    "request_archive",
    {
      title: "Archive Request",
      description: "Move an active requests/{id} tree to archive/{id} without deleting data.",
      inputSchema: {
        id: requestIdSchema,
      },
      outputSchema: outputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id }) =>
      handled(async () => {
        const request = await archiveRequest(id);
        return textResult(`Archived request ${id}.`, {
          ok: true,
          agentExplanation: "The complete request directory was moved from requests to archive.",
          data: request,
        });
      }),
  );

  server.registerTool(
    "request_list",
    {
      title: "List Requests",
      description: "List active request objects without content. Archived requests are stored on disk but are not exposed through MCP.",
      inputSchema: {
        offset: z.number().int().optional(),
        size: z.number().int().optional(),
        before: z.string().optional().describe("Optional ISO timestamp. Return requests updated before this time."),
        after: z.string().optional().describe("Optional ISO timestamp. Return requests updated after this time."),
        createdBefore: z.string().optional().describe("Optional ISO timestamp. Return requests created before this time. Uses the hourly request creation index when paired with createdAfter."),
        createdAfter: z.string().optional().describe("Optional ISO timestamp. Return requests created after this time. Uses data/index/requests/YYYY-MM-DD_HH files for fast recent windows."),
        status: requestStatusSchema.optional(),
      },
      outputSchema: outputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ offset, size, before, after, createdBefore, createdAfter, status }) =>
      handled(async () => {
        const entries = await listRequests({
          ...(offset !== undefined ? { offset } : {}),
          ...(size !== undefined ? { size } : {}),
          ...(before !== undefined ? { before } : {}),
          ...(after !== undefined ? { after } : {}),
          ...(createdBefore !== undefined ? { createdBefore } : {}),
          ...(createdAfter !== undefined ? { createdAfter } : {}),
          ...(status !== undefined ? { status: status as RequestVersionStatus } : {}),
        });
        const requests = entries.map(publicRequest);
        return textResult(`Found ${requests.length} request${requests.length === 1 ? "" : "s"}.`, {
          ok: true,
          agentExplanation: "The list contains request metadata only. Use request_read, response_read, or reasoning_read for content.",
          data: requests,
        });
      }),
  );

  server.registerTool(
    "request_versions",
    {
      title: "Request Versions",
      description: "List versions of one active request with request, response, and reasoning status/size/token metadata.",
      inputSchema: {
        id: requestIdSchema,
      },
      outputSchema: outputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) =>
      handled(async () => {
        await resolveActiveRequestPair(id);
        const versions = await requestVersions(id);
        return textResult(`Found ${versions.length} version${versions.length === 1 ? "" : "s"} for request ${id}.`, {
          ok: true,
          agentExplanation: "Each version reports immutable request metadata and response/reasoning metadata when those files exist.",
          data: versions,
        });
      }),
  );

  server.registerTool(
    "request_read",
    {
      title: "Read Request",
      description: "Tool wrapper over deepseek://request/{id}{?version}.",
      inputSchema: {
        id: requestIdSchema,
        version: z.number().int().min(0).optional(),
      },
      outputSchema: outputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, version }) =>
      handled(async () => {
        const pair = await resolveActiveRequestPair(id, undefined, version);
        const data = await readRequestResource(pair.id, undefined, pair.version);
        return textResult(`Read request ${id} version ${data.request.version}.`, {
          ok: true,
          agentExplanation: "This is the same data exposed through the canonical request resource.",
          data,
        });
      }),
  );

  server.registerTool(
    "response_read",
    {
      title: "Read Response",
      description: "Tool wrapper over deepseek://response/{id}{?version}.",
      inputSchema: {
        id: requestIdSchema,
        version: z.number().int().min(0).optional(),
      },
      outputSchema: outputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, version }) =>
      handled(async () => {
        const pair = await resolveActiveRequestPair(id, undefined, version);
        const data = await readResponseResource(pair.id, undefined, pair.version);
        return textResult(`Read response ${id} version ${data.response.version}.`, {
          ok: true,
          agentExplanation: "This is the same data exposed through the canonical response resource.",
          data,
        });
      }),
  );

  server.registerTool(
    "reasoning_read",
    {
      title: "Read Reasoning",
      description: "Tool wrapper over deepseek://reasoning/{id}{?version}.",
      inputSchema: {
        id: requestIdSchema,
        version: z.number().int().min(0).optional(),
      },
      outputSchema: outputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, version }) =>
      handled(async () => {
        const pair = await resolveActiveRequestPair(id, undefined, version);
        const data = await readReasoningResource(pair.id, undefined, pair.version);
        return textResult(`Read reasoning ${id} version ${data.reasoning.version}.`, {
          ok: true,
          agentExplanation: "This is the same data exposed through the canonical reasoning resource.",
          data,
        });
      }),
  );

  server.registerTool(
    "request_submit",
    {
      title: "Submit Request",
      description: "Send the current active request version to DeepSeek and save the answer as RESPONSE.md plus REASONING.md. The server counts tokens and estimated cost locally before the API call; a successful submit means the caller wants the model answer.",
      inputSchema: requestSubmitInputSchema,
      outputSchema: outputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ id, progressInterval, model, thinking, reasoning, responseFormat, maxTokens, temperature, reserveOutputTokens, safetyMarginTokens }, extra) =>
      handled(async () => {
        const prepared = await prepareSubmit({
          id,
          progressInterval,
          model,
          thinking,
          reasoning,
          responseFormat,
          maxTokens,
          temperature,
          ...(reserveOutputTokens !== undefined ? { reserveOutputTokens } : {}),
          ...(safetyMarginTokens !== undefined ? { safetyMarginTokens } : {}),
        });

        const startedAt = Date.now();
        if (progressInterval !== 0) {
          await sendSubmitStartLog(server, extra, {
            pair: prepared.pair,
            progressInterval,
            promptText: prepared.promptText,
            payloadResult: prepared.payloadResult,
            validationResult: prepared.validationResult,
            requestedOptions: prepared.requestedOptions,
            sendOptions: prepared.sendOptions,
          });
        }

        let lastLogAt = 0;
        let lastLoggedPhase: ProgressEvent["phase"] | undefined;
        const progress = async (currentProgress: ProgressEvent) => {
          if (progressInterval === 0) {
            return;
          }
          const now = Date.now();
          if (currentProgress.phase !== lastLoggedPhase || now - lastLogAt >= progressInterval * 1000) {
            lastLogAt = now;
            lastLoggedPhase = currentProgress.phase;
            await sendSubmitProgressLog(server, extra, prepared.pair, currentProgress, startedAt);
          }
        };

        const data = await executePreparedSubmit(prepared, progress);
        return textResult(`${prepared.preflightSummary}\nDeepSeek response saved for request ${prepared.pair.id} version ${prepared.pair.version}.`, {
          ok: true,
          agentExplanation:
            "The submitted request version is immutable. RESPONSE.md and REASONING.md belong to the version that was sent. Usage and actual cost are included when DeepSeek returned usage.",
          data,
        });
      }),
  );

  server.registerTool(
    "request_batch",
    {
      title: "Submit Request Batch",
      description:
        "Submit multiple active request ids in parallel with one shared DeepSeek launch configuration. This is a separate batch workflow: it validates every request, runs the valid requests concurrently, saves each response/reasoning into its own request version, emits one aggregate progress log per tick, and returns per-request success/error results. Progress logs use the format: \"12s Batch: 4 Active: 3 Finished: 1 Error: 0 Reasoning: 17472 Response: 46363\".",
      inputSchema: requestSubmitBatchInputSchema,
      outputSchema: outputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ ids, progressInterval, model, thinking, reasoning, responseFormat, maxTokens, temperature, reserveOutputTokens, safetyMarginTokens }, extra) =>
      handled(async () => {
        assertUniqueBatchIds(ids);
        const startedAt = Date.now();
        const commonInput: Omit<SubmitRequestInput, "id"> = {
          progressInterval,
          model,
          thinking,
          reasoning,
          responseFormat,
          maxTokens,
          temperature,
          ...(reserveOutputTokens !== undefined ? { reserveOutputTokens } : {}),
          ...(safetyMarginTokens !== undefined ? { safetyMarginTokens } : {}),
        };
        const states: BatchRequestState[] = ids.map((id) => ({
          id,
          status: "active",
          reasoningBytes: 0,
          responseBytes: 0,
        }));

        const prepared = await Promise.all(
          states.map(async (state) => {
            try {
              const submit = await prepareSubmit(submitInputForId(state.id, commonInput));
              state.version = submit.pair.version;
              return { state, submit };
            } catch (error) {
              state.status = "error";
              state.error = errorMessage(error);
              return { state };
            }
          }),
        );
        const runnable = prepared.filter((item): item is { state: BatchRequestState; submit: PreparedSubmit } => "submit" in item);

        let timer: ReturnType<typeof setInterval> | undefined;
        if (progressInterval !== 0) {
          await sendBatchProgressLog(server, extra, states, startedAt);
          timer = setInterval(() => {
            void sendBatchProgressLog(server, extra, states, startedAt);
          }, progressInterval * 1000);
        }

        try {
          await Promise.all(
            runnable.map(async ({ state, submit }) => {
              try {
                const data = await executePreparedSubmit(submit, (progress) => {
                  if (progress.phase === "download") {
                    state.reasoningBytes = progress.reasoningBytes;
                    state.responseBytes = progress.responseBytes;
                  }
                });
                const responseSize = (data.response as { size?: unknown }).size;
                const reasoningSize = (data.reasoning as { size?: unknown }).size;
                if (typeof responseSize === "number") {
                  state.responseBytes = responseSize;
                }
                if (typeof reasoningSize === "number") {
                  state.reasoningBytes = reasoningSize;
                }
                state.status = "finished";
                state.data = data;
              } catch (error) {
                state.status = "error";
                state.error = errorMessage(error);
              }
            }),
          );
        } finally {
          if (timer !== undefined) {
            clearInterval(timer);
          }
          if (progressInterval !== 0) {
            await sendBatchProgressLog(server, extra, states, startedAt);
            await sendBatchResultLog(server, extra, states);
          }
        }

        const counts = batchCounts(states);
        const results = states.map((state) => ({
          id: state.id,
          ...(state.version !== undefined ? { version: state.version } : {}),
          ok: state.status === "finished",
          status: state.status,
          reasoningBytes: state.reasoningBytes,
          responseBytes: state.responseBytes,
          ...(state.error !== undefined ? { error: state.error } : {}),
          ...(state.data !== undefined
            ? {
                request: state.data.request,
                response: state.data.response,
                reasoning: state.data.reasoning,
                validation: state.data.validation,
                usage: state.data.usage,
                actualCost: state.data.actualCost,
                preflightCost: state.data.preflightCost,
              }
            : {}),
        }));
        const ok = counts.error === 0;
        return textResult(`Batch completed. Finished ${counts.finished}/${counts.total}; errors ${counts.error}.`, {
          ok,
          agentExplanation:
            "request_batch submitted valid request ids concurrently with one shared launch configuration. The result contains per-request status and metadata only; read response/reasoning resources for saved content.",
          data: {
            statusCode: ok ? 200 : 207,
            batch: {
              durationSeconds: secondsSince(startedAt),
              ...counts,
            },
            results,
          },
        });
      }),
  );

  server.registerResource(
    "request",
    new ResourceTemplate("deepseek://request/{id}{?version}", { list: requestResourceList }),
    {
      title: "Request",
      description: "Read request metadata and REQUEST.md content for the selected version.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      try {
        return await requestResourceContents(uri, idFromVariables(variables.id));
      } catch (error) {
        mcpResourceError(error);
      }
    },
  );

  server.registerResource(
    "response",
    new ResourceTemplate("deepseek://response/{id}{?version}", { list: responseResourceList }),
    {
      title: "Response",
      description: "Read response metadata and RESPONSE.md content for the selected request version.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      try {
        return await responseResourceContents(uri, idFromVariables(variables.id));
      } catch (error) {
        mcpResourceError(error);
      }
    },
  );

  server.registerResource(
    "reasoning",
    new ResourceTemplate("deepseek://reasoning/{id}{?version}", { list: reasoningResourceList }),
    {
      title: "Reasoning",
      description: "Read reasoning metadata and REASONING.md content for the selected request version.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      try {
        return await reasoningResourceContents(uri, idFromVariables(variables.id));
      } catch (error) {
        mcpResourceError(error);
      }
    },
  );

  server.registerResource(
    "models",
    "deepseek://models",
    {
      title: "DeepSeek V4 Models",
      description: "Machine-readable model limits, pricing, feature flags, and local token accounting policy.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: stringifyPretty(DEEPSEEK_MODELS.map((model) => MODEL_SPECS[model])),
        },
      ],
    }),
  );

  server.registerResource(
    "account_balance",
    "deepseek://account_balance",
    {
      title: "Account Balance",
      description: "Machine-readable DeepSeek account balance from GET /user/balance using the MCP process DEEPSEEK_API_KEY.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const balance = await getDeepSeekAccountBalance();
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: stringifyPretty(balance) }],
        };
      } catch (error) {
        mcpResourceError(error);
      }
    },
  );

  server.registerResource(
    "instructions",
    "deepseek://instructions",
    {
      title: "Agent Instructions",
      description: "Operational guidance for Codex agents using this MCP server.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: [
            "# DeepSeek MCP Agent Instructions",
            "",
            "1. Create a request with `request_create`.",
            "2. Add content with `request_update`; this creates a new immutable version.",
            "3. Read canonically through `deepseek://request/{id}{?version}`, `deepseek://response/{id}{?version}`, and `deepseek://reasoning/{id}{?version}`.",
            "4. Submit with `request_submit`; it counts tokens locally before sending, then saves the DeepSeek answer.",
            "5. Use `request_batch` for multiple independent request ids that should run in parallel with the same launch parameters; it logs aggregate active/finished/error counts and reasoning/response bytes.",
            "6. Use `request_list` with `createdAfter`/`createdBefore` for fast recent windows; the server reads `index/requests/{YYYY-MM-DD_HH}` instead of scanning every request directory.",
            "7. Archive with `request_archive`; archived requests live under `archive/{id}` and are not exposed through MCP reads/lists.",
            "8. Read balance through `deepseek://account_balance`; this MCP server always uses DEEPSEEK_API_KEY from its own process environment.",
          ].join("\n"),
        },
      ],
    }),
  );

  server.registerPrompt(
    "prepare_request",
    {
      title: "Prepare DeepSeek Request",
      description: "Prompt template that tells Codex how to create, validate, and send a versioned DeepSeek request.",
      argsSchema: {
        task: z.string().describe("What the user wants DeepSeek to work on."),
        model: modelSchema.default("deepseek-v4-pro"),
      },
    },
    async ({ task, model }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Prepare a DeepSeek request for model ${model}.\n\n` +
              `Task:\n${task}\n\n` +
              "Use request_create and request_update or request_append_zip to assemble REQUEST.md, then call request_submit to get one DeepSeek answer. Use request_batch when several independent request ids should run in parallel with the same launch parameters. Read saved content through the request/response/reasoning resources.",
          },
        },
      ],
    }),
  );

  return server;
}
