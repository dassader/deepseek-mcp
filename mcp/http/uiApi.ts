import { type IncomingMessage, type ServerResponse } from "node:http";
import {
  archiveRequest,
  listRequests,
  readReasoningResource,
  readReasoningObject,
  readRequestObject,
  readRequestResource,
  readRequestVersionMeta,
  readResponseObject,
  readResponseResource,
  requestVersions,
  restoreArchivedRequest,
  RequestStoreError,
  type ArchiveEntry,
  type DeepSeekRequest,
  type RequestScope,
  type RequestVersionSummary,
  type RequestVersionStatus,
} from "../archive/archive.js";
import { requestScopedCache } from "../archive/requestCache.js";
import { DeepSeekAccountBalanceError, getDeepSeekAccountBalance } from "../deepseek/balance.js";
import { estimateTokenUsageCost } from "../deepseek/cost.js";
import { DEEPSEEK_MODELS, type DeepSeekModel } from "../deepseek/models.js";
import { stringifyPretty } from "../shared/json.js";

const API_PREFIX = "/api/ui";
const STATUS_VALUES = new Set<RequestVersionStatus>(["draft", "pending", "filling", "filled", "error"]);
const SCOPE_VALUES = new Set<RequestScope>(["active", "archived", "all"]);
type UiCreatedRange = "1h" | "6h" | "12h" | "1d" | "1w" | "all";
const CREATED_RANGE_VALUES = new Set<UiCreatedRange>(["1h", "6h", "12h", "1d", "1w", "all"]);

interface UiRequestSummary {
  id: string;
  title: string;
  created: string;
  updated: string;
  version: number;
  displayVersion: number;
  status: RequestVersionStatus;
  size: number;
  tokens: number;
  lines: number;
  archived: boolean;
  hasResponse: boolean;
  hasReasoning: boolean;
  requestBytes: number;
  responseBytes?: number;
  reasoningBytes?: number;
  modifiedAt: string;
}

type UiDeepSeekRequest = DeepSeekRequest & { displayVersion: number };
type UiVersionSummary = RequestVersionSummary & { displayVersion: number };

interface StatsTotals {
  requestCount: number;
  activeRequestCount: number;
  archivedRequestCount: number;
  versionCount: number;
  submittedVersionCount: number;
  filledVersionCount: number;
  errorVersionCount: number;
  sentBytes: number;
  receivedBytes: number;
  requestBytes: number;
  responseBytes: number;
  reasoningBytes: number;
  requestTokens: number;
  sentTokens: number;
  responseTokens: number;
  reasoningTokens: number;
  outputTokens: number;
  estimatedCostCacheHitUsd: number;
  estimatedCostCacheMissUsd: number;
}

interface StatsVersionRow {
  id: string;
  title: string;
  archived: boolean;
  version: number;
  displayVersion: number;
  status: RequestVersionStatus;
  updated: string;
  model?: DeepSeekModel;
  sentBytes: number;
  requestBytes: number;
  responseBytes: number;
  reasoningBytes: number;
  receivedBytes: number;
  requestTokens: number;
  sentTokens: number;
  responseTokens: number;
  reasoningTokens: number;
  outputTokens: number;
  estimatedCostCacheHitUsd: number;
  estimatedCostCacheMissUsd: number;
}

interface StatsRequestRow extends StatsTotals {
  id: string;
  title: string;
  archived: boolean;
  updated: string;
}

interface StatsPeriodRow extends StatsTotals {
  period: string;
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "accept, content-type");
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) {
    return;
  }
  setCorsHeaders(response);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(stringifyPretty(body));
}

function uiError(response: ServerResponse, error: unknown): void {
  const statusCode = error instanceof RequestStoreError || error instanceof DeepSeekAccountBalanceError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : String(error);
  writeJson(response, statusCode, {
    ok: false,
    error: {
      message,
      statusCode,
    },
  });
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
}

function pathSegments(pathname: string): string[] {
  return pathname
    .slice(API_PREFIX.length)
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

function visibleUiVersions(versions: RequestVersionSummary[]): UiVersionSummary[] {
  return versions.filter((version) => !isEmptyInitialDraftVersion(version)).map((version, index) => ({
    ...version,
    displayVersion: index + 1,
  }));
}

function displayVersionForVersion(versions: RequestVersionSummary[], version: number): number {
  const visibleVersions = visibleUiVersions(versions);
  const exact = visibleVersions.find((item) => item.version === version);
  if (exact !== undefined) {
    return exact.displayVersion;
  }
  const previousVisibleCount = visibleVersions.filter((item) => item.version <= version).length;
  return Math.max(1, previousVisibleCount);
}

async function uiRequestSummary(entry: ArchiveEntry): Promise<UiRequestSummary> {
  const versions = await requestVersions(entry.id);
  return {
    id: entry.id,
    title: entry.title,
    created: entry.created,
    updated: entry.updated,
    version: entry.version,
    displayVersion: displayVersionForVersion(versions, entry.version),
    status: entry.status,
    size: entry.size,
    tokens: entry.tokens,
    lines: entry.lines,
    archived: entry.archived,
    hasResponse: entry.hasResponse,
    hasReasoning: entry.hasReasoning,
    requestBytes: entry.requestBytes,
    ...(entry.responseBytes !== undefined ? { responseBytes: entry.responseBytes } : {}),
    ...(entry.reasoningBytes !== undefined ? { reasoningBytes: entry.reasoningBytes } : {}),
    modifiedAt: entry.modifiedAt,
  };
}

function uiDeepSeekRequest(request: DeepSeekRequest, versions: RequestVersionSummary[]): UiDeepSeekRequest {
  return {
    ...request,
    displayVersion: displayVersionForVersion(versions, request.version),
  };
}

function isEmptyInitialDraftVersion(version: RequestVersionSummary): boolean {
  return (
    version.version === 0 &&
    version.requestStatus === "draft" &&
    version.requestSize === 0 &&
    version.requestTokens === 0 &&
    version.requestLines === 0 &&
    version.responseStatus === undefined &&
    version.responseSize === undefined &&
    version.reasoningStatus === undefined &&
    version.reasoningSize === undefined
  );
}

function emptyTotals(): StatsTotals {
  return {
    requestCount: 0,
    activeRequestCount: 0,
    archivedRequestCount: 0,
    versionCount: 0,
    submittedVersionCount: 0,
    filledVersionCount: 0,
    errorVersionCount: 0,
    sentBytes: 0,
    receivedBytes: 0,
    requestBytes: 0,
    responseBytes: 0,
    reasoningBytes: 0,
    requestTokens: 0,
    sentTokens: 0,
    responseTokens: 0,
    reasoningTokens: 0,
    outputTokens: 0,
    estimatedCostCacheHitUsd: 0,
    estimatedCostCacheMissUsd: 0,
  };
}

function addTotals(target: StatsTotals, value: Partial<StatsTotals>): void {
  target.requestCount += value.requestCount ?? 0;
  target.activeRequestCount += value.activeRequestCount ?? 0;
  target.archivedRequestCount += value.archivedRequestCount ?? 0;
  target.versionCount += value.versionCount ?? 0;
  target.submittedVersionCount += value.submittedVersionCount ?? 0;
  target.filledVersionCount += value.filledVersionCount ?? 0;
  target.errorVersionCount += value.errorVersionCount ?? 0;
  target.sentBytes += value.sentBytes ?? 0;
  target.receivedBytes += value.receivedBytes ?? 0;
  target.requestBytes += value.requestBytes ?? 0;
  target.responseBytes += value.responseBytes ?? 0;
  target.reasoningBytes += value.reasoningBytes ?? 0;
  target.requestTokens += value.requestTokens ?? 0;
  target.sentTokens += value.sentTokens ?? 0;
  target.responseTokens += value.responseTokens ?? 0;
  target.reasoningTokens += value.reasoningTokens ?? 0;
  target.outputTokens += value.outputTokens ?? 0;
  target.estimatedCostCacheHitUsd += value.estimatedCostCacheHitUsd ?? 0;
  target.estimatedCostCacheMissUsd += value.estimatedCostCacheMissUsd ?? 0;
}

function roundUsd(value: number): number {
  return Number(value.toPrecision(12));
}

function periodKey(value: string, granularity: "day" | "month"): string {
  return granularity === "day" ? value.slice(0, 10) : value.slice(0, 7);
}

function modelFromUnknown(value: unknown): DeepSeekModel | undefined {
  return typeof value === "string" && DEEPSEEK_MODELS.includes(value as DeepSeekModel) ? (value as DeepSeekModel) : undefined;
}

function modelFromLaunchSettings(value: unknown): DeepSeekModel | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const settings = value as { effectiveApiParameters?: { model?: unknown }; requestedOptions?: { model?: unknown } };
  return modelFromUnknown(settings.effectiveApiParameters?.model) ?? modelFromUnknown(settings.requestedOptions?.model);
}

async function optionalResource<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof RequestStoreError && error.statusCode === 404) {
      return undefined;
    }
    throw error;
  }
}

function scopeFromQuery(value: string | null): RequestScope {
  if (value === null || value.trim() === "") {
    return "active";
  }
  if (!SCOPE_VALUES.has(value as RequestScope)) {
    throw new RequestStoreError(`Invalid scope: ${value}`, 400);
  }
  return value as RequestScope;
}

function statusFromQuery(value: string | null): RequestVersionStatus | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  if (!STATUS_VALUES.has(value as RequestVersionStatus)) {
    throw new RequestStoreError(`Invalid status: ${value}`, 400);
  }
  return value as RequestVersionStatus;
}

function createdRangeFromQuery(value: string | null): UiCreatedRange {
  if (value === null || value.trim() === "") {
    return "all";
  }
  if (!CREATED_RANGE_VALUES.has(value as UiCreatedRange)) {
    throw new RequestStoreError(`Invalid createdRange: ${value}`, 400);
  }
  return value as UiCreatedRange;
}

function createdAfterForRange(range: UiCreatedRange, now = Date.now()): string | undefined {
  const hour = 60 * 60 * 1000;
  const ranges: Record<Exclude<UiCreatedRange, "all">, number> = {
    "1h": hour,
    "6h": 6 * hour,
    "12h": 12 * hour,
    "1d": 24 * hour,
    "1w": 7 * 24 * hour,
  };
  return range === "all" ? undefined : new Date(now - ranges[range]).toISOString();
}

function entryMatchesMetadata(entry: ArchiveEntry, needle: string): boolean {
  return [entry.id, entry.title, entry.status, entry.version.toString(), entry.archived ? "archived" : "active"].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

async function optionalContent(read: () => Promise<{ content: string }>): Promise<string> {
  try {
    return (await read()).content;
  } catch (error) {
    if (error instanceof RequestStoreError && error.statusCode === 404) {
      return "";
    }
    throw error;
  }
}

async function entryMatchesFullText(entry: ArchiveEntry, needle: string): Promise<boolean> {
  if (entryMatchesMetadata(entry, needle)) {
    return true;
  }
  const versions = await requestVersions(entry.id);
  for (const version of versions) {
    const request = await readRequestResource(entry.id, undefined, version.version);
    if (request.content.toLowerCase().includes(needle)) {
      return true;
    }
    const [response, reasoning] = await Promise.all([
      optionalContent(() => readResponseResource(entry.id, undefined, version.version)),
      optionalContent(() => readReasoningResource(entry.id, undefined, version.version)),
    ]);
    if (response.toLowerCase().includes(needle) || reasoning.toLowerCase().includes(needle)) {
      return true;
    }
  }
  return false;
}

async function listUiRequests(url: URL): Promise<Record<string, unknown>> {
  const scope = scopeFromQuery(url.searchParams.get("scope"));
  const status = statusFromQuery(url.searchParams.get("status"));
  const createdRange = createdRangeFromQuery(url.searchParams.get("createdRange"));
  const createdAfter = createdAfterForRange(createdRange);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const entries = await listRequests({
    scope,
    ...(status !== undefined ? { status } : {}),
    ...(createdAfter !== undefined ? { createdAfter } : {}),
  });
  const needle = q.toLowerCase();
  const filtered =
    needle.length === 0
      ? entries
      : (
          await Promise.all(
            entries.map(async (entry) => ({
              entry,
              matches: await entryMatchesFullText(entry, needle),
            })),
          )
        )
          .filter((item) => item.matches)
          .map((item) => item.entry);

  return {
    ok: true,
    data: {
      scope,
      status,
      createdRange,
      q,
      requests: await Promise.all(filtered.map((entry) => uiRequestSummary(entry))),
    },
  };
}

async function readUiRequest(id: string): Promise<Record<string, unknown>> {
  const request = await readRequestResource(id);
  const versions = await requestVersions(id);
  return {
    ok: true,
    data: {
      request: uiDeepSeekRequest(request.request, versions),
      versions: visibleUiVersions(versions),
    },
  };
}

async function readUiVersion(id: string, version: number): Promise<Record<string, unknown>> {
  const request = await readRequestResource(id, undefined, version);
  const versions = await requestVersions(id);
  const [responseResource, reasoningResource] = await Promise.all([
    optionalResource(() => readResponseResource(id, undefined, version)),
    optionalResource(() => readReasoningResource(id, undefined, version)),
  ]);
  return {
    ok: true,
    data: {
      request: {
        request: uiDeepSeekRequest(request.request, versions),
        content: request.content,
      },
      response: responseResource?.content ?? "",
      reasoning: reasoningResource?.content ?? "",
      responseResource:
        responseResource === undefined
          ? undefined
          : {
              response: responseResource.response,
              content: responseResource.content,
            },
      reasoningResource:
        reasoningResource === undefined
          ? undefined
          : {
              reasoning: reasoningResource.reasoning,
              content: reasoningResource.content,
            },
    },
  };
}

function versionTotals(row: StatsVersionRow): Partial<StatsTotals> {
  return {
    versionCount: 1,
    submittedVersionCount: row.model !== undefined || row.status !== "draft" ? 1 : 0,
    filledVersionCount: row.status === "filled" ? 1 : 0,
    errorVersionCount: row.status === "error" ? 1 : 0,
    sentBytes: row.sentBytes,
    receivedBytes: row.receivedBytes,
    requestBytes: row.requestBytes,
    responseBytes: row.responseBytes,
    reasoningBytes: row.reasoningBytes,
    requestTokens: row.requestTokens,
    sentTokens: row.sentTokens,
    responseTokens: row.responseTokens,
    reasoningTokens: row.reasoningTokens,
    outputTokens: row.outputTokens,
    estimatedCostCacheHitUsd: row.estimatedCostCacheHitUsd,
    estimatedCostCacheMissUsd: row.estimatedCostCacheMissUsd,
  };
}

function sortedPeriods(map: Map<string, StatsTotals>): StatsPeriodRow[] {
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([period, totals]) => ({ period, ...totals }));
}

async function statsVersionRow(entry: ArchiveEntry, version: number, displayVersion: number): Promise<StatsVersionRow> {
  return requestScopedCache.getOrCompute(
    { rootDir: entry.rootDir, id: entry.id },
    `ui:stats-version:${version}:${displayVersion}`,
    async () => {
      const [request, requestMeta] = await Promise.all([readRequestObject(entry.id, undefined, version), readRequestVersionMeta(entry.id, undefined, version)]);
      const [response, reasoning] = await Promise.all([
        optionalResource(() => readResponseObject(entry.id, undefined, version)),
        optionalResource(() => readReasoningObject(entry.id, undefined, version)),
      ]);
      const model =
        modelFromLaunchSettings(requestMeta.launchSettings) ??
        modelFromUnknown(response?.price.model) ??
        modelFromUnknown(reasoning?.price.model);
      const submitted = requestMeta.status !== "draft" || requestMeta.launchSettings !== undefined;
      const sentTokens = submitted ? request.tokens : 0;
      const sentBytes = submitted ? request.size : 0;
      const responseTokens = response?.tokens ?? 0;
      const reasoningTokens = reasoning?.tokens ?? 0;
      const outputTokens = responseTokens + reasoningTokens;
      const estimate = model !== undefined && submitted ? estimateTokenUsageCost(model, sentTokens, outputTokens) : undefined;
      return {
        id: entry.id,
        title: entry.title,
        archived: entry.archived,
        version,
        displayVersion,
        status: requestMeta.status,
        updated: requestMeta.updated,
        ...(model !== undefined ? { model } : {}),
        sentBytes,
        requestBytes: request.size,
        responseBytes: response?.size ?? 0,
        reasoningBytes: reasoning?.size ?? 0,
        receivedBytes: (response?.size ?? 0) + (reasoning?.size ?? 0),
        requestTokens: request.tokens,
        sentTokens,
        responseTokens,
        reasoningTokens,
        outputTokens,
        estimatedCostCacheHitUsd: estimate?.totalIfAllInputCacheHitUsd ?? 0,
        estimatedCostCacheMissUsd: estimate?.totalIfAllInputCacheMissUsd ?? 0,
      };
    },
    (row) => row.status !== "pending" && row.status !== "filling",
  );
}

async function statsForUi(url: URL): Promise<Record<string, unknown>> {
  const scope = scopeFromQuery(url.searchParams.get("scope") ?? "all");
  const createdRange = createdRangeFromQuery(url.searchParams.get("createdRange"));
  const createdAfter = createdAfterForRange(createdRange);
  const entries = await listRequests({
    scope,
    ...(createdAfter !== undefined ? { createdAfter } : {}),
  });
  const totals = emptyTotals();
  totals.requestCount = entries.length;
  totals.activeRequestCount = entries.filter((entry) => !entry.archived).length;
  totals.archivedRequestCount = entries.filter((entry) => entry.archived).length;

  const byDay = new Map<string, StatsTotals>();
  const byMonth = new Map<string, StatsTotals>();
  const byModel = new Map<string, StatsTotals>();
  const byStatus = new Map<string, StatsTotals>();
  const requests: StatsRequestRow[] = [];
  const versions: StatsVersionRow[] = [];

  for (const entry of entries) {
    const requestTotals: StatsRequestRow = {
      id: entry.id,
      title: entry.title,
      archived: entry.archived,
      updated: entry.updated,
      ...emptyTotals(),
      requestCount: 1,
      activeRequestCount: entry.archived ? 0 : 1,
      archivedRequestCount: entry.archived ? 1 : 0,
    };
    const versionSummaries = await requestVersions(entry.id);
    for (const versionSummary of visibleUiVersions(versionSummaries)) {
      const row = await statsVersionRow(entry, versionSummary.version, versionSummary.displayVersion);
      versions.push(row);
      const contribution = versionTotals(row);
      addTotals(totals, contribution);
      addTotals(requestTotals, contribution);

      const day = periodKey(row.updated, "day");
      const month = periodKey(row.updated, "month");
      const model = row.model ?? "unknown";
      const status = row.status;
      if (!byDay.has(day)) byDay.set(day, emptyTotals());
      if (!byMonth.has(month)) byMonth.set(month, emptyTotals());
      if (!byModel.has(model)) byModel.set(model, emptyTotals());
      if (!byStatus.has(status)) byStatus.set(status, emptyTotals());
      addTotals(byDay.get(day)!, contribution);
      addTotals(byMonth.get(month)!, contribution);
      addTotals(byModel.get(model)!, contribution);
      addTotals(byStatus.get(status)!, contribution);
    }
    requests.push(requestTotals);
  }

  totals.estimatedCostCacheHitUsd = roundUsd(totals.estimatedCostCacheHitUsd);
  totals.estimatedCostCacheMissUsd = roundUsd(totals.estimatedCostCacheMissUsd);
  for (const value of [...byDay.values(), ...byMonth.values(), ...byModel.values(), ...byStatus.values(), ...requests]) {
    value.estimatedCostCacheHitUsd = roundUsd(value.estimatedCostCacheHitUsd);
    value.estimatedCostCacheMissUsd = roundUsd(value.estimatedCostCacheMissUsd);
  }

  return {
    ok: true,
    data: {
      generatedAt: new Date().toISOString(),
      scope,
      createdRange,
      assumptions: [
        "Costs are estimated from saved request/response/reasoning token counts and the saved model in request.json.",
        "Historical DeepSeek billing usage is not currently persisted, so totals are shown as cache-hit to cache-miss estimates.",
        "sentBytes counts submitted REQUEST.md content bytes. receivedBytes counts saved RESPONSE.md plus REASONING.md bytes.",
      ],
      totals,
      byDay: sortedPeriods(byDay),
      byMonth: sortedPeriods(byMonth),
      byModel: [...byModel.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([model, value]) => ({ model, ...value })),
      byStatus: [...byStatus.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([status, value]) => ({ status, ...value })),
      requests: requests.sort((left, right) => right.estimatedCostCacheMissUsd - left.estimatedCostCacheMissUsd || right.sentTokens - left.sentTokens),
      versions: versions.sort((left, right) => Date.parse(right.updated) - Date.parse(left.updated)),
      topCostVersions: [...versions].sort((left, right) => right.estimatedCostCacheMissUsd - left.estimatedCostCacheMissUsd).slice(0, 20),
      topTokenVersions: [...versions].sort((left, right) => right.sentTokens + right.outputTokens - (left.sentTokens + left.outputTokens)).slice(0, 20),
    },
  };
}

function versionFromSegment(value: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RequestStoreError(`Invalid version: ${value}`, 400);
  }
  return version;
}

export async function handleUiApiRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = requestUrl(request);
  if (!url.pathname.startsWith(API_PREFIX)) {
    return false;
  }
  setCorsHeaders(response);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return true;
  }

  try {
    const segments = pathSegments(url.pathname);
    if (request.method === "GET" && segments.length === 1 && segments[0] === "requests") {
      writeJson(response, 200, await listUiRequests(url));
      return true;
    }
    if (request.method === "GET" && segments.length === 1 && segments[0] === "stats") {
      writeJson(response, 200, await statsForUi(url));
      return true;
    }
    if (request.method === "GET" && segments.length === 1 && segments[0] === "account-balance") {
      writeJson(response, 200, { ok: true, data: await getDeepSeekAccountBalance() });
      return true;
    }
    if (request.method === "GET" && segments.length === 2 && segments[0] === "requests") {
      writeJson(response, 200, await readUiRequest(segments[1] ?? ""));
      return true;
    }
    if (request.method === "GET" && segments.length === 4 && segments[0] === "requests" && segments[2] === "versions") {
      writeJson(response, 200, await readUiVersion(segments[1] ?? "", versionFromSegment(segments[3] ?? "")));
      return true;
    }
    if (request.method === "POST" && segments.length === 3 && segments[0] === "requests" && segments[2] === "archive") {
      writeJson(response, 200, { ok: true, data: await archiveRequest(segments[1] ?? "") });
      return true;
    }
    if (request.method === "POST" && segments.length === 3 && segments[0] === "requests" && segments[2] === "restore") {
      writeJson(response, 200, { ok: true, data: await restoreArchivedRequest(segments[1] ?? "") });
      return true;
    }
    writeJson(response, 404, {
      ok: false,
      error: {
        message: `Unknown UI API endpoint: ${url.pathname}`,
        statusCode: 404,
      },
    });
    return true;
  } catch (error) {
    uiError(response, error);
    return true;
  }
}
