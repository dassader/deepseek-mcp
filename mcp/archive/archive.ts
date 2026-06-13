import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { estimateTokenUsageCost, type TokenUsageCostEstimate } from "../deepseek/cost.js";
import type { DeepSeekLaunchSettings } from "../deepseek/launchSettings.js";
import { DEEPSEEK_MODELS, canonicalModelAndThinking, type DeepSeekModel } from "../deepseek/models.js";
import { countTextTokens } from "../deepseek/tokenizer.js";
import { stringifyPretty } from "../shared/json.js";
import { defaultDataDir, displayPath, resolveUserPath } from "../shared/paths.js";
import {
  appendRequestCreationIndex,
  readRequestCreationIndexIds,
  requestCreationIndexBackfillMarkerPath,
  withRequestCreationIndexMaintenanceLock,
} from "./requestIndex.js";
import { requestScopedCache, type RequestCacheScope } from "./requestCache.js";

export const REQUEST_FILE_NAME = "REQUEST.md";
export const RESPONSE_FILE_NAME = "RESPONSE.md";
export const REASONING_FILE_NAME = "REASONING.md";
export const META_FILE_NAME = "meta.json";
export const REQUEST_JSON_FILE_NAME = "request.json";
export const RESPONSE_JSON_FILE_NAME = "response.json";
export const REASONING_JSON_FILE_NAME = "reasoning.json";
export const SUBMIT_LEASE_FILE_NAME = "submit.lock.json";
export const ACTIVE_REQUESTS_DIR_NAME = "requests";
export const ARCHIVED_REQUESTS_DIR_NAME = "archive";
export const VERSIONS_DIR_NAME = "versions";
export const DEFAULT_SUBMIT_LEASE_STALE_MS = 30 * 60 * 1000;

export const ARCHIVE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type RequestVersionStatus = "draft" | "pending" | "filling" | "filled" | "error";
export type ResponseStatus = "pending" | "filling" | "filled" | "error";
export type ReasoningStatus = "pending" | "filling" | "filled" | "empty" | "error";
export type RequestScope = "active" | "archived" | "all";

export interface RequestMeta {
  title: string;
  created: string;
  updated: string;
}

export interface RequestVersionMeta {
  status: RequestVersionStatus;
  created: string;
  updated: string;
  launchSettings?: DeepSeekLaunchSettings;
  error?: string;
  deepseekStatusCode?: number;
}

export interface ResponseMeta {
  status: ResponseStatus;
  created: string;
  updated: string;
  error?: string;
}

export interface ReasoningMeta {
  status: ReasoningStatus;
  created: string;
  updated: string;
  error?: string;
}

export interface SubmitLease {
  ownerPid: number;
  started: string;
  updated: string;
}

export interface DeepSeekRequest {
  id: string;
  title: string;
  created: string;
  updated: string;
  version: number;
  status: RequestVersionStatus;
  size: number;
  tokens: number;
  lines: number;
  price: Partial<Record<DeepSeekModel, TokenUsageCostEstimate>>;
  archived: boolean;
  error?: string;
  deepseekStatusCode?: number;
}

export interface DeepSeekResponse {
  id: string;
  title: string;
  version: number;
  status: ResponseStatus;
  created: string;
  updated: string;
  size: number;
  tokens: number;
  lines: number;
  price: TokenUsageCostEstimate;
  error?: string;
}

export interface DeepSeekReasoning {
  id: string;
  title: string;
  version: number;
  status: ReasoningStatus;
  created: string;
  updated: string;
  size: number;
  tokens: number;
  lines: number;
  price: TokenUsageCostEstimate;
  error?: string;
}

export interface RequestPair {
  id: string;
  safeName: string;
  title: string;
  rootDir: string;
  sessionDir: string;
  requestDir: string;
  versionsDir: string;
  versionDir: string;
  version: number;
  archived: boolean;
  requestPath: string;
  responsePath: string;
  reasoningPath: string;
  metaPath: string;
  requestJsonPath: string;
  responseJsonPath: string;
  reasoningJsonPath: string;
}

export interface ArchiveEntry extends DeepSeekRequest, RequestPair {
  hasResponse: boolean;
  hasReasoning: boolean;
  requestBytes: number;
  requestLines: number;
  responseBytes?: number;
  responseLines?: number;
  reasoningBytes?: number;
  reasoningLines?: number;
  modifiedAt: string;
  meta: RequestMeta;
}

export interface RequestVersionSummary {
  version: number;
  isCurrent: boolean;
  requestStatus: RequestVersionStatus;
  requestSize: number;
  requestTokens: number;
  requestLines: number;
  responseStatus?: ResponseStatus;
  responseSize?: number;
  responseTokens?: number;
  responseLines?: number;
  reasoningStatus?: ReasoningStatus;
  reasoningSize?: number;
  reasoningTokens?: number;
  reasoningLines?: number;
}

export interface CreateRequestOptions {
  requestText?: string;
}

export interface ListRequestsOptions {
  rootDir?: string;
  offset?: number;
  size?: number;
  before?: string;
  after?: string;
  createdBefore?: string;
  createdAfter?: string;
  status?: RequestVersionStatus;
  scope?: RequestScope;
}

export interface SubmitArtifacts {
  request: DeepSeekRequest;
  response: DeepSeekResponse;
  reasoning: DeepSeekReasoning;
}

export interface AppendRequestResult {
  request: DeepSeekRequest;
  version: number;
  createdVersion: boolean;
}

export class RequestStoreError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "RequestStoreError";
  }
}

interface RequestLocation {
  rootDir: string;
  requestDir: string;
  id: string;
  archived: boolean;
}

interface StoreDirs {
  rootDir: string;
  activeDir: string;
  archivedDir: string;
}

interface TextFileStats {
  size: number;
  tokens: number;
  lines: number;
}

export function dataDir(input?: string): string {
  return resolveUserPath(input, process.env.DEEPSEEK_DATA_DIR ?? defaultDataDir);
}

export function requestStoreDirs(input?: string): StoreDirs {
  const rootDir = dataDir(input);
  return {
    rootDir,
    activeDir: path.join(rootDir, ACTIVE_REQUESTS_DIR_NAME),
    archivedDir: path.join(rootDir, ARCHIVED_REQUESTS_DIR_NAME),
  };
}

export function sanitizeName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[/:\\\0]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/^[ .]+|[ .]+$/g, "");
  return cleaned || "request";
}

export function normalizeTitle(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    throw new RequestStoreError("Request title is required. Use a short phrase explaining what or why the agent is asking DeepSeek.", 400);
  }
  if (normalized.length < 3) {
    throw new RequestStoreError("Request title must be at least 3 characters long.", 400);
  }
  if (normalized.length > 160) {
    throw new RequestStoreError("Request title must be 160 characters or fewer.", 400);
  }
  return normalized;
}

function nowIso(): string {
  return new Date().toISOString();
}

function pathsForRequest(location: RequestLocation, title: string, version: number): RequestPair {
  const versionsDir = path.join(location.requestDir, VERSIONS_DIR_NAME);
  const versionDir = path.join(versionsDir, String(version));
  return {
    id: location.id,
    safeName: sanitizeName(title),
    title,
    rootDir: location.rootDir,
    sessionDir: location.requestDir,
    requestDir: location.requestDir,
    versionsDir,
    versionDir,
    version,
    archived: location.archived,
    requestPath: path.join(versionDir, REQUEST_FILE_NAME),
    responsePath: path.join(versionDir, RESPONSE_FILE_NAME),
    reasoningPath: path.join(versionDir, REASONING_FILE_NAME),
    metaPath: path.join(location.requestDir, META_FILE_NAME),
    requestJsonPath: path.join(versionDir, REQUEST_JSON_FILE_NAME),
    responseJsonPath: path.join(versionDir, RESPONSE_JSON_FILE_NAME),
    reasoningJsonPath: path.join(versionDir, REASONING_JSON_FILE_NAME),
  };
}

function cacheScopeForLocation(location: RequestLocation): RequestCacheScope {
  return { rootDir: location.rootDir, id: location.id };
}

function cacheScopeForPair(pair: RequestPair): RequestCacheScope {
  return { rootDir: pair.rootDir, id: pair.id };
}

function invalidateRequestCacheForLocation(location: RequestLocation): void {
  requestScopedCache.invalidate(cacheScopeForLocation(location));
}

function invalidateRequestCacheForPair(pair: RequestPair): void {
  requestScopedCache.invalidate(cacheScopeForPair(pair));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function readOptionalJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return await readJsonFile<T>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, `${stringifyPretty(value)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

function submitLeasePath(pair: RequestPair): string {
  return path.join(pair.versionDir, SUBMIT_LEASE_FILE_NAME);
}

function submitLeaseStaleMs(): number {
  const configured = Number(process.env.DEEPSEEK_SUBMIT_LEASE_STALE_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_SUBMIT_LEASE_STALE_MS;
}

function isRunningStatus(status: RequestVersionStatus | ResponseStatus | ReasoningStatus): boolean {
  return status === "pending" || status === "filling";
}

async function writeSubmitLease(pair: RequestPair, started: string): Promise<void> {
  await writeJsonFile(submitLeasePath(pair), { ownerPid: process.pid, started, updated: started } satisfies SubmitLease);
}

export async function touchRequestSubmitLease(pair: RequestPair): Promise<void> {
  const leasePath = submitLeasePath(pair);
  const current = (await readOptionalJsonFile<SubmitLease>(leasePath)) ?? { ownerPid: process.pid, started: nowIso(), updated: nowIso() };
  await writeJsonFile(leasePath, { ...current, ownerPid: process.pid, updated: nowIso() } satisfies SubmitLease);
}

async function removeSubmitLease(pair: RequestPair): Promise<void> {
  try {
    await fs.unlink(submitLeasePath(pair));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function isSubmitLeaseStale(pair: RequestPair, requestMeta: RequestVersionMeta): Promise<boolean> {
  const staleMs = submitLeaseStaleMs();
  try {
    const stat = await fs.stat(submitLeasePath(pair));
    return Date.now() - stat.mtimeMs > staleMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return Date.now() - Date.parse(requestMeta.updated) > staleMs;
  }
}

async function markInterruptedSubmit(pair: RequestPair, requestMeta: RequestVersionMeta): Promise<RequestVersionMeta> {
  const updated = nowIso();
  const error = "Request submission was interrupted before completion. The worker heartbeat is missing or stale.";
  const next: RequestVersionMeta = { ...requestMeta, status: "error", error, updated };
  await writeJsonFile(pair.requestJsonPath, next);
  if (await fileExists(pair.responseJsonPath)) {
    await updateResponseMeta(pair, { status: "error", error, updated });
  }
  if (await fileExists(pair.reasoningJsonPath)) {
    await updateReasoningMeta(pair, { status: "error", error, updated });
  }
  const meta = await readMeta(pair.requestDir);
  await writeMeta(pair.requestDir, { ...meta, updated });
  await removeSubmitLease(pair);
  invalidateRequestCacheForPair(pair);
  return next;
}

async function readRequestVersionMetaForPair(pair: RequestPair): Promise<RequestVersionMeta> {
  return requestScopedCache.getOrCompute(
    cacheScopeForPair(pair),
    `request-version-meta:${pair.version}`,
    async () => {
      const requestMeta = await readJsonFile<RequestVersionMeta>(pair.requestJsonPath);
      if (isRunningStatus(requestMeta.status) && (await isSubmitLeaseStale(pair, requestMeta))) {
        return markInterruptedSubmit(pair, requestMeta);
      }
      return requestMeta;
    },
    (meta) => !isRunningStatus(meta.status),
  );
}

async function readOptionalResponseMetaForPair(pair: RequestPair): Promise<ResponseMeta | undefined> {
  return requestScopedCache.getOrCompute(
    cacheScopeForPair(pair),
    `response-meta:${pair.version}`,
    () => readOptionalJsonFile<ResponseMeta>(pair.responseJsonPath),
    (meta) => meta === undefined || !isRunningStatus(meta.status),
  );
}

async function readOptionalReasoningMetaForPair(pair: RequestPair): Promise<ReasoningMeta | undefined> {
  return requestScopedCache.getOrCompute(
    cacheScopeForPair(pair),
    `reasoning-meta:${pair.version}`,
    () => readOptionalJsonFile<ReasoningMeta>(pair.reasoningJsonPath),
    (meta) => meta === undefined || !isRunningStatus(meta.status),
  );
}

async function readMeta(requestDir: string): Promise<RequestMeta> {
  return readJsonFile<RequestMeta>(path.join(requestDir, META_FILE_NAME));
}

async function readMetaForLocation(location: RequestLocation): Promise<RequestMeta> {
  return requestScopedCache.getOrCompute(cacheScopeForLocation(location), "meta", () => readMeta(location.requestDir));
}

async function readMetaForPair(pair: RequestPair): Promise<RequestMeta> {
  return requestScopedCache.getOrCompute(cacheScopeForPair(pair), "meta", () => readMeta(pair.requestDir));
}

async function writeMeta(requestDir: string, meta: RequestMeta): Promise<void> {
  await writeJsonFile(path.join(requestDir, META_FILE_NAME), meta);
}

function versionNumberFromName(name: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/u.test(name)) {
    return undefined;
  }
  const version = Number(name);
  return Number.isSafeInteger(version) ? version : undefined;
}

async function listVersionNumbers(requestDir: string): Promise<number[]> {
  const versionsDir = path.join(requestDir, VERSIONS_DIR_NAME);
  let entries: string[];
  try {
    entries = await fs.readdir(versionsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const versions: number[] = [];
  for (const entry of entries) {
    const version = versionNumberFromName(entry);
    if (version === undefined) {
      continue;
    }
    const versionDir = path.join(versionsDir, entry);
    try {
      const stat = await fs.stat(versionDir);
      if (stat.isDirectory()) {
        versions.push(version);
      }
    } catch {
      continue;
    }
  }
  return versions.sort((left, right) => left - right);
}

async function listVersionNumbersForLocation(location: RequestLocation): Promise<number[]> {
  return requestScopedCache.getOrCompute(cacheScopeForLocation(location), "version-numbers", () => listVersionNumbers(location.requestDir));
}

async function currentVersionForLocation(location: RequestLocation): Promise<number> {
  const versions = await listVersionNumbersForLocation(location);
  const version = versions.at(-1);
  if (version === undefined) {
    throw new RequestStoreError(`Request has no versions: ${displayPath(location.requestDir)}`, 500);
  }
  return version;
}

async function findRequestLocation(id: string, rootDirInput?: string): Promise<RequestLocation | undefined> {
  const dirs = requestStoreDirs(rootDirInput);
  const activeDir = path.join(dirs.activeDir, id);
  if (await fileExists(path.join(activeDir, META_FILE_NAME))) {
    return { rootDir: dirs.rootDir, requestDir: activeDir, id, archived: false };
  }
  const archivedDir = path.join(dirs.archivedDir, id);
  if (await fileExists(path.join(archivedDir, META_FILE_NAME))) {
    return { rootDir: dirs.rootDir, requestDir: archivedDir, id, archived: true };
  }
  return undefined;
}

async function findActiveRequestLocation(id: string, rootDirInput?: string): Promise<RequestLocation> {
  const dirs = requestStoreDirs(rootDirInput);
  const activeDir = path.join(dirs.activeDir, id);
  if (await fileExists(path.join(activeDir, META_FILE_NAME))) {
    return { rootDir: dirs.rootDir, requestDir: activeDir, id, archived: false };
  }
  const archivedDir = path.join(dirs.archivedDir, id);
  if (await fileExists(path.join(archivedDir, META_FILE_NAME))) {
    throw new RequestStoreError(`Request ${id} is archived and is not exposed through MCP active request APIs. Create a new active request if more work is needed.`, 409);
  }
  throw new RequestStoreError(`Request ${id} was not found in active requests. It may have been archived or never created.`, 404);
}

function countTextLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let count = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      count += 1;
    }
  }
  return count;
}

async function statTextFile(filePath: string): Promise<TextFileStats> {
  const text = await fs.readFile(filePath, "utf8");
  return {
    size: Buffer.byteLength(text, "utf8"),
    tokens: countTextTokens(text),
    lines: countTextLines(text),
  };
}

function textFilePathForPair(pair: RequestPair, kind: "request" | "response" | "reasoning"): string {
  if (kind === "request") return pair.requestPath;
  if (kind === "response") return pair.responsePath;
  return pair.reasoningPath;
}

async function statTextFileForPair(pair: RequestPair, kind: "request" | "response" | "reasoning", cacheable = true): Promise<TextFileStats> {
  if (!cacheable) {
    return statTextFile(textFilePathForPair(pair, kind));
  }
  return requestScopedCache.getOrCompute(cacheScopeForPair(pair), `text-stat:${kind}:${pair.version}`, () => statTextFile(textFilePathForPair(pair, kind)));
}

async function statOptionalTextFileForPair(
  pair: RequestPair,
  kind: "request" | "response" | "reasoning",
  cacheable = true,
): Promise<TextFileStats | undefined> {
  try {
    return await statTextFileForPair(pair, kind, cacheable);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function requestInputPrice(tokens: number): Partial<Record<DeepSeekModel, TokenUsageCostEstimate>> {
  return Object.fromEntries(DEEPSEEK_MODELS.map((model) => [model, estimateTokenUsageCost(model, tokens, 0)])) as Partial<
    Record<DeepSeekModel, TokenUsageCostEstimate>
  >;
}

function submittedModel(requestMeta: RequestVersionMeta, pair: RequestPair): DeepSeekModel {
  const effectiveModel = requestMeta.launchSettings?.effectiveApiParameters.model;
  const requestedModel = requestMeta.launchSettings?.requestedOptions.model;
  const model = typeof effectiveModel === "string" ? effectiveModel : typeof requestedModel === "string" ? requestedModel : undefined;
  if (!model) {
    throw new RequestStoreError(`Request ${pair.id} version ${pair.version} has response metadata but no saved launchSettings model.`, 500);
  }
  try {
    return canonicalModelAndThinking(model, "omit").model;
  } catch (error) {
    throw new RequestStoreError(
      `Request ${pair.id} version ${pair.version} saved unsupported launchSettings model ${JSON.stringify(model)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      500,
    );
  }
}

async function submittedOutputPrice(pair: RequestPair, outputTokens: number): Promise<TokenUsageCostEstimate> {
  const requestMeta = await readRequestVersionMetaForPair(pair);
  return estimateTokenUsageCost(submittedModel(requestMeta, pair), 0, outputTokens);
}

async function pairForLocation(location: RequestLocation, versionInput?: number): Promise<RequestPair> {
  const meta = await readMetaForLocation(location);
  const version = versionInput ?? (await currentVersionForLocation(location));
  const versions = await listVersionNumbersForLocation(location);
  if (!versions.includes(version)) {
    throw new RequestStoreError(`Request ${location.id} does not have version ${version}.`, 404);
  }
  return pathsForRequest(location, meta.title, version);
}

async function requestObjectForPair(pair: RequestPair): Promise<DeepSeekRequest> {
  return requestScopedCache.getOrCompute(
    cacheScopeForPair(pair),
    `request-object:${pair.version}:${pair.archived ? "archived" : "active"}`,
    async () => {
      const meta = await readMetaForPair(pair);
      const requestMeta = await readRequestVersionMetaForPair(pair);
      const file = await statTextFileForPair(pair, "request");
      return {
        id: pair.id,
        title: meta.title,
        created: meta.created,
        updated: meta.updated,
        version: pair.version,
        status: requestMeta.status,
        size: file.size,
        tokens: file.tokens,
        lines: file.lines,
        price: requestInputPrice(file.tokens),
        archived: pair.archived,
        ...(requestMeta.error !== undefined ? { error: requestMeta.error } : {}),
        ...(requestMeta.deepseekStatusCode !== undefined ? { deepseekStatusCode: requestMeta.deepseekStatusCode } : {}),
      };
    },
    (request) => !isRunningStatus(request.status),
  );
}

async function responseObjectForPair(pair: RequestPair): Promise<DeepSeekResponse> {
  return requestScopedCache.getOrCompute(
    cacheScopeForPair(pair),
    `response-object:${pair.version}`,
    async () => {
      const meta = await readMetaForPair(pair);
      await readRequestVersionMetaForPair(pair);
      const responseMeta = await readOptionalResponseMetaForPair(pair);
      if (!responseMeta) {
        throw new RequestStoreError(`Response for request ${pair.id} version ${pair.version} does not exist because that version has not been submitted to DeepSeek.`, 404);
      }
      const file = await statTextFileForPair(pair, "response", !isRunningStatus(responseMeta.status));
      return {
        id: pair.id,
        title: meta.title,
        version: pair.version,
        status: responseMeta.status,
        created: responseMeta.created,
        updated: responseMeta.updated,
        size: file.size,
        tokens: file.tokens,
        lines: file.lines,
        price: await submittedOutputPrice(pair, file.tokens),
        ...(responseMeta.error !== undefined ? { error: responseMeta.error } : {}),
      };
    },
    (response) => !isRunningStatus(response.status),
  );
}

async function reasoningObjectForPair(pair: RequestPair): Promise<DeepSeekReasoning> {
  return requestScopedCache.getOrCompute(
    cacheScopeForPair(pair),
    `reasoning-object:${pair.version}`,
    async () => {
      const meta = await readMetaForPair(pair);
      await readRequestVersionMetaForPair(pair);
      const reasoningMeta = await readOptionalReasoningMetaForPair(pair);
      if (!reasoningMeta) {
        throw new RequestStoreError(`Reasoning for request ${pair.id} version ${pair.version} does not exist because that version has not been submitted to DeepSeek.`, 404);
      }
      const file = await statTextFileForPair(pair, "reasoning", !isRunningStatus(reasoningMeta.status));
      return {
        id: pair.id,
        title: meta.title,
        version: pair.version,
        status: reasoningMeta.status,
        created: reasoningMeta.created,
        updated: reasoningMeta.updated,
        size: file.size,
        tokens: file.tokens,
        lines: file.lines,
        price: await submittedOutputPrice(pair, file.tokens),
        ...(reasoningMeta.error !== undefined ? { error: reasoningMeta.error } : {}),
      };
    },
    (reasoning) => !isRunningStatus(reasoning.status),
  );
}

async function archiveEntryForLocation(location: RequestLocation): Promise<ArchiveEntry | undefined> {
  return requestScopedCache.getOrCompute(
    cacheScopeForLocation(location),
    `archive-entry:${location.archived ? "archived" : "active"}`,
    async () => {
      const meta = await readMetaForLocation(location);
      const version = await currentVersionForLocation(location);
      const pair = pathsForRequest(location, meta.title, version);
      const request = await requestObjectForPair(pair);
      const [responseMeta, reasoningMeta] = await Promise.all([readOptionalResponseMetaForPair(pair), readOptionalReasoningMetaForPair(pair)]);
      const [responseStat, reasoningStat] = await Promise.all([
        responseMeta ? statOptionalTextFileForPair(pair, "response", !isRunningStatus(responseMeta.status)) : undefined,
        reasoningMeta ? statOptionalTextFileForPair(pair, "reasoning", !isRunningStatus(reasoningMeta.status)) : undefined,
      ]);
      return {
        ...pair,
        ...request,
        hasResponse: responseStat !== undefined,
        hasReasoning: reasoningStat !== undefined,
        requestBytes: request.size,
        requestLines: request.lines,
        ...(responseStat ? { responseBytes: responseStat.size, responseLines: responseStat.lines } : {}),
        ...(reasoningStat ? { reasoningBytes: reasoningStat.size, reasoningLines: reasoningStat.lines } : {}),
        modifiedAt: meta.updated,
        meta,
      };
    },
    (entry) => !isRunningStatus(entry.status),
  );
}

function listOptionsFromInput(input?: string | ListRequestsOptions): ListRequestsOptions {
  return typeof input === "string" ? { rootDir: input } : input ?? {};
}

function scopeDirs(options: ListRequestsOptions): Array<{ dir: string; archived: boolean }> {
  const dirs = requestStoreDirs(options.rootDir);
  const scope = options.scope ?? "active";
  if (scope === "active") {
    return [{ dir: dirs.activeDir, archived: false }];
  }
  if (scope === "archived") {
    return [{ dir: dirs.archivedDir, archived: true }];
  }
  return [
    { dir: dirs.activeDir, archived: false },
    { dir: dirs.archivedDir, archived: true },
  ];
}

async function scanLocations(options: ListRequestsOptions): Promise<RequestLocation[]> {
  const dirs = requestStoreDirs(options.rootDir);
  const locations: RequestLocation[] = [];
  for (const scoped of scopeDirs(options)) {
    let entries: string[];
    try {
      entries = await fs.readdir(scoped.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }

    for (const entry of entries) {
      const requestDir = path.join(scoped.dir, entry);
      try {
        const stat = await fs.stat(requestDir);
        if (stat.isDirectory() && (await fileExists(path.join(requestDir, META_FILE_NAME)))) {
          locations.push({ rootDir: dirs.rootDir, requestDir, id: entry, archived: scoped.archived });
        }
      } catch {
        continue;
      }
    }
  }
  return locations;
}

async function ensureRequestCreationIndexBackfilled(rootDirInput?: string): Promise<void> {
  const dirs = requestStoreDirs(rootDirInput);
  const markerPath = requestCreationIndexBackfillMarkerPath(dirs.rootDir);
  if (await fileExists(markerPath)) {
    return;
  }

  await withRequestCreationIndexMaintenanceLock(dirs.rootDir, async () => {
    if (await fileExists(markerPath)) {
      return;
    }
    const locations = await scanLocations({ ...(rootDirInput !== undefined ? { rootDir: rootDirInput } : {}), scope: "all" });
    for (const location of locations) {
      const meta = await readMeta(location.requestDir);
      await appendRequestCreationIndex(dirs.rootDir, meta.created, location.id);
    }
    await fs.writeFile(markerPath, `${new Date().toISOString()}\n`, { encoding: "utf8", flag: "wx" });
  });
}

async function listIndexedLocations(options: ListRequestsOptions): Promise<RequestLocation[] | undefined> {
  const dirs = requestStoreDirs(options.rootDir);
  const indexedIds = await readRequestCreationIndexIds(dirs.rootDir, {
    ...(options.createdAfter !== undefined ? { createdAfter: options.createdAfter } : {}),
    ...(options.createdBefore !== undefined ? { createdBefore: options.createdBefore } : {}),
  });
  if (indexedIds === undefined) {
    return undefined;
  }

  await ensureRequestCreationIndexBackfilled(options.rootDir);
  const refreshedIds = await readRequestCreationIndexIds(dirs.rootDir, {
    ...(options.createdAfter !== undefined ? { createdAfter: options.createdAfter } : {}),
    ...(options.createdBefore !== undefined ? { createdBefore: options.createdBefore } : {}),
  });
  const locations: RequestLocation[] = [];
  const seen = new Set<string>();
  for (const id of refreshedIds ?? []) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    for (const scoped of scopeDirs(options)) {
      const requestDir = path.join(scoped.dir, id);
      if (await fileExists(path.join(requestDir, META_FILE_NAME))) {
        locations.push({ rootDir: dirs.rootDir, requestDir, id, archived: scoped.archived });
        break;
      }
    }
  }
  return locations;
}

async function listLocations(options: ListRequestsOptions): Promise<RequestLocation[]> {
  return (await listIndexedLocations(options)) ?? scanLocations(options);
}

function matchesTimeFilters(entry: ArchiveEntry, options: ListRequestsOptions): boolean {
  const updated = Date.parse(entry.updated);
  const created = Date.parse(entry.created);
  if (options.before !== undefined && updated >= Date.parse(options.before)) {
    return false;
  }
  if (options.after !== undefined && updated <= Date.parse(options.after)) {
    return false;
  }
  if (options.createdBefore !== undefined && created >= Date.parse(options.createdBefore)) {
    return false;
  }
  if (options.createdAfter !== undefined && created <= Date.parse(options.createdAfter)) {
    return false;
  }
  return true;
}

export async function createRequestFile(titleInput: string, dirInput?: string, options: CreateRequestOptions = {}): Promise<RequestPair> {
  const dirs = requestStoreDirs(dirInput);
  await fs.mkdir(dirs.activeDir, { recursive: true });
  const title = normalizeTitle(titleInput);
  const created = nowIso();

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = randomUUID();
    const requestDir = path.join(dirs.activeDir, id);
    try {
      await fs.mkdir(path.join(requestDir, VERSIONS_DIR_NAME, "0"), { recursive: true });
      const location: RequestLocation = { rootDir: dirs.rootDir, requestDir, id, archived: false };
      const pair = pathsForRequest(location, title, 0);
      await fs.writeFile(pair.requestPath, options.requestText ?? "", { encoding: "utf8", flag: "wx" });
      await writeMeta(requestDir, { title, created, updated: created });
      await writeJsonFile(pair.requestJsonPath, { status: "draft", created, updated: created } satisfies RequestVersionMeta);
      await appendRequestCreationIndex(dirs.rootDir, created, id);
      invalidateRequestCacheForPair(pair);
      return pair;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new RequestStoreError("Could not create a unique UUID request directory.", 500);
}

export async function updateRequestContent(id: string, content: string, dirInput?: string): Promise<DeepSeekRequest> {
  const location = await findActiveRequestLocation(id, dirInput);
  const current = await pairForLocation(location);
  const currentMeta = await readRequestVersionMetaForPair(current);
  if (currentMeta.status === "pending" || currentMeta.status === "filling") {
    throw new RequestStoreError(`Request ${id} cannot be updated while DeepSeek is still answering version ${current.version}.`, 409);
  }

  const nextVersion = current.version + 1;
  const meta = await readMeta(location.requestDir);
  const pair = pathsForRequest(location, meta.title, nextVersion);
  const updated = nowIso();
  await fs.mkdir(pair.versionDir, { recursive: true });
  await fs.writeFile(pair.requestPath, content, { encoding: "utf8", flag: "wx" });
  await writeJsonFile(pair.requestJsonPath, { status: "draft", created: updated, updated } satisfies RequestVersionMeta);
  await writeMeta(location.requestDir, { ...meta, updated });
  invalidateRequestCacheForPair(pair);
  return requestObjectForPair(pair);
}

export async function appendRequestContent(id: string, content: string, dirInput?: string): Promise<AppendRequestResult> {
  const location = await findActiveRequestLocation(id, dirInput);
  const pair = await pairForLocation(location);
  const requestMeta = await readRequestVersionMetaForPair(pair);
  if (requestMeta.status === "pending" || requestMeta.status === "filling") {
    throw new RequestStoreError(`Request ${id} cannot be appended while DeepSeek is still answering version ${pair.version}.`, 409);
  }
  if (requestMeta.status !== "draft") {
    const request = await updateRequestContent(id, content, dirInput);
    return {
      request,
      version: request.version,
      createdVersion: true,
    };
  }

  const updated = nowIso();
  await fs.appendFile(pair.requestPath, content, "utf8");
  await writeJsonFile(pair.requestJsonPath, { ...requestMeta, updated } satisfies RequestVersionMeta);
  const meta = await readMeta(location.requestDir);
  await writeMeta(location.requestDir, { ...meta, updated });
  invalidateRequestCacheForPair(pair);
  const request = await requestObjectForPair(pair);
  return {
    request,
    version: request.version,
    createdVersion: false,
  };
}

export async function archiveRequest(id: string, dirInput?: string): Promise<DeepSeekRequest> {
  const dirs = requestStoreDirs(dirInput);
  const location = await findActiveRequestLocation(id, dirInput);
  const current = await pairForLocation(location);
  const requestMeta = await readRequestVersionMetaForPair(current);
  if (requestMeta.status === "pending" || requestMeta.status === "filling") {
    throw new RequestStoreError(`Request ${id} cannot be archived while DeepSeek is still answering version ${current.version}.`, 409);
  }

  const meta = await readMeta(location.requestDir);
  const updated = nowIso();
  await writeMeta(location.requestDir, { ...meta, updated });
  await fs.mkdir(dirs.archivedDir, { recursive: true });
  const archivedDir = path.join(dirs.archivedDir, id);
  await fs.rename(location.requestDir, archivedDir);
  invalidateRequestCacheForLocation(location);
  const archivedLocation: RequestLocation = { rootDir: dirs.rootDir, requestDir: archivedDir, id, archived: true };
  return requestObjectForPair(await pairForLocation(archivedLocation));
}

export async function restoreArchivedRequest(id: string, dirInput?: string): Promise<DeepSeekRequest> {
  const dirs = requestStoreDirs(dirInput);
  const archivedDir = path.join(dirs.archivedDir, id);
  const activeDir = path.join(dirs.activeDir, id);
  if (await fileExists(path.join(activeDir, META_FILE_NAME))) {
    throw new RequestStoreError(`Request ${id} is already active.`, 409);
  }
  if (!(await fileExists(path.join(archivedDir, META_FILE_NAME)))) {
    throw new RequestStoreError(`Archived request ${id} was not found.`, 404);
  }

  const archivedLocation: RequestLocation = { rootDir: dirs.rootDir, requestDir: archivedDir, id, archived: true };
  const current = await pairForLocation(archivedLocation);
  const requestMeta = await readRequestVersionMetaForPair(current);
  if (requestMeta.status === "pending" || requestMeta.status === "filling") {
    throw new RequestStoreError(`Request ${id} cannot be restored while version ${current.version} is ${requestMeta.status}.`, 409);
  }

  const meta = await readMeta(archivedDir);
  const updated = nowIso();
  await writeMeta(archivedDir, { ...meta, updated });
  await fs.mkdir(dirs.activeDir, { recursive: true });
  await fs.rename(archivedDir, activeDir);
  invalidateRequestCacheForLocation(archivedLocation);
  const activeLocation: RequestLocation = { rootDir: dirs.rootDir, requestDir: activeDir, id, archived: false };
  return requestObjectForPair(await pairForLocation(activeLocation));
}

export async function listRequests(input?: string | ListRequestsOptions): Promise<ArchiveEntry[]> {
  const options = listOptionsFromInput(input);
  const locations = await listLocations(options);
  const entries = (await Promise.all(locations.map((location) => archiveEntryForLocation(location)))).filter((entry): entry is ArchiveEntry => Boolean(entry));
  const filtered = entries
    .filter((entry) => (options.status === undefined ? true : entry.status === options.status))
    .filter((entry) => matchesTimeFilters(entry, options))
    .sort((left, right) => Date.parse(right.updated) - Date.parse(left.updated) || left.id.localeCompare(right.id));
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const end = options.size === undefined ? undefined : offset + Math.max(0, Math.trunc(options.size));
  return filtered.slice(offset, end);
}

function matchesLocator(entry: ArchiveEntry, locator: string): boolean {
  const safeLocator = sanitizeName(locator);
  return entry.id === locator || entry.safeName === safeLocator || entry.title === locator || entry.meta.title === locator;
}

export async function resolveRequestPair(locator: string, dirInput?: string, id?: string, allowAnswered = true): Promise<RequestPair> {
  if (id !== undefined && id.trim() !== "") {
    const location = await findRequestLocation(id, dirInput);
    if (!location) {
      throw new RequestStoreError(`Request ${id} was not found in active requests or archive.`, 404);
    }
    return pairForLocation(location);
  }

  if (!locator.trim()) {
    throw new RequestStoreError("Provide request id, name, or title.", 400);
  }

  const matches = (await listRequests({ ...(dirInput !== undefined ? { rootDir: dirInput } : {}), scope: "active" })).filter((entry) => matchesLocator(entry, locator));
  if (matches.length === 0) {
    throw new RequestStoreError(`No active request found for id/title: ${JSON.stringify(locator)}.`, 404);
  }
  const drafts = matches.filter((entry) => entry.status === "draft");
  const latest = (allowAnswered ? drafts[0] ?? matches[0] : drafts[0]) ?? matches[0];
  if (!latest) {
    throw new RequestStoreError(`No active request found for id/title: ${JSON.stringify(locator)}.`, 404);
  }
  if (!allowAnswered && latest.status !== "draft") {
    throw new RequestStoreError(`Latest request version is ${latest.status}, not draft. Create a new version before sending again.`, 409);
  }
  return pairForLocation({ rootDir: latest.rootDir, requestDir: latest.requestDir, id: latest.id, archived: latest.archived });
}

export async function resolveActiveRequestPair(id: string, dirInput?: string, version?: number): Promise<RequestPair> {
  return pairForLocation(await findActiveRequestLocation(id, dirInput), version);
}

export async function resolveAnyRequestPair(id: string, dirInput?: string, version?: number): Promise<RequestPair> {
  const location = await findRequestLocation(id, dirInput);
  if (!location) {
    throw new RequestStoreError(`Request ${id} was not found in active requests or archive.`, 404);
  }
  return pairForLocation(location, version);
}

export async function readRequestText(pair: RequestPair): Promise<string> {
  return fs.readFile(pair.requestPath, "utf8");
}

export async function readRequestVersionMeta(id: string, dirInput?: string, version?: number): Promise<RequestVersionMeta> {
  const pair = await resolveAnyRequestPair(id, dirInput, version);
  return readRequestVersionMetaForPair(pair);
}

export async function writeRequestText(_pair: RequestPair, _text: string): Promise<void> {
  throw new RequestStoreError("Existing REQUEST.md files are immutable. Use request_update to create a new version.", 409);
}

export async function readRequestObject(id: string, dirInput?: string, version?: number): Promise<DeepSeekRequest> {
  return requestObjectForPair(await resolveAnyRequestPair(id, dirInput, version));
}

export async function readResponseObject(id: string, dirInput?: string, version?: number): Promise<DeepSeekResponse> {
  return responseObjectForPair(await resolveAnyRequestPair(id, dirInput, version));
}

export async function readReasoningObject(id: string, dirInput?: string, version?: number): Promise<DeepSeekReasoning> {
  return reasoningObjectForPair(await resolveAnyRequestPair(id, dirInput, version));
}

export async function readRequestResource(id: string, dirInput?: string, version?: number): Promise<{ request: DeepSeekRequest; content: string }> {
  const pair = await resolveAnyRequestPair(id, dirInput, version);
  return {
    request: await requestObjectForPair(pair),
    content: await readRequestText(pair),
  };
}

export async function readResponseResource(id: string, dirInput?: string, version?: number): Promise<{ response: DeepSeekResponse; content: string }> {
  const pair = await resolveAnyRequestPair(id, dirInput, version);
  return {
    response: await responseObjectForPair(pair),
    content: await fs.readFile(pair.responsePath, "utf8"),
  };
}

export async function readReasoningResource(id: string, dirInput?: string, version?: number): Promise<{ reasoning: DeepSeekReasoning; content: string }> {
  const pair = await resolveAnyRequestPair(id, dirInput, version);
  return {
    reasoning: await reasoningObjectForPair(pair),
    content: await fs.readFile(pair.reasoningPath, "utf8"),
  };
}

export async function readResponse(pair: RequestPair): Promise<{ response: string; meta?: unknown }> {
  const response = await fs.readFile(pair.responsePath, "utf8");
  const meta = await readOptionalJsonFile(pair.responseJsonPath);
  return { response, ...(meta !== undefined ? { meta } : {}) };
}

export async function readReasoning(pair: RequestPair): Promise<string> {
  try {
    return await fs.readFile(pair.reasoningPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export async function ensureResponseWritable(pair: RequestPair, overwrite: boolean): Promise<void> {
  const requestMeta = await readRequestVersionMetaForPair(pair);
  if (requestMeta.status !== "draft") {
    throw new RequestStoreError(`Request ${pair.id} version ${pair.version} is ${requestMeta.status}. Only draft versions can be submitted.`, 409);
  }
  if (!overwrite && (await fileExists(pair.responseJsonPath))) {
    throw new RequestStoreError(`Response already exists for request ${pair.id} version ${pair.version}. Create a new version with request_update before submitting again.`, 409);
  }
}

export async function updateRequestMeta(pair: RequestPair, patch: Partial<RequestMeta>): Promise<RequestMeta> {
  const current = await readMeta(pair.requestDir);
  const next: RequestMeta = {
    title: patch.title !== undefined ? normalizeTitle(patch.title) : current.title,
    created: patch.created ?? current.created,
    updated: patch.updated ?? current.updated,
  };
  await writeMeta(pair.requestDir, next);
  invalidateRequestCacheForPair(pair);
  return next;
}

export async function updateRequestVersionMeta(pair: RequestPair, patch: Partial<RequestVersionMeta>): Promise<RequestVersionMeta> {
  const current = await readJsonFile<RequestVersionMeta>(pair.requestJsonPath);
  const next: RequestVersionMeta = {
    ...current,
    ...patch,
    updated: patch.updated ?? nowIso(),
  };
  await writeJsonFile(pair.requestJsonPath, next);
  invalidateRequestCacheForPair(pair);
  return next;
}

export async function updateResponseMeta(pair: RequestPair, patch: Partial<ResponseMeta>): Promise<ResponseMeta> {
  const current = (await readOptionalJsonFile<ResponseMeta>(pair.responseJsonPath)) ?? { status: "pending", created: nowIso(), updated: nowIso() };
  const next: ResponseMeta = {
    ...current,
    ...patch,
    updated: patch.updated ?? nowIso(),
  };
  await writeJsonFile(pair.responseJsonPath, next);
  invalidateRequestCacheForPair(pair);
  return next;
}

export async function updateReasoningMeta(pair: RequestPair, patch: Partial<ReasoningMeta>): Promise<ReasoningMeta> {
  const current = (await readOptionalJsonFile<ReasoningMeta>(pair.reasoningJsonPath)) ?? { status: "pending", created: nowIso(), updated: nowIso() };
  const next: ReasoningMeta = {
    ...current,
    ...patch,
    updated: patch.updated ?? nowIso(),
  };
  await writeJsonFile(pair.reasoningJsonPath, next);
  invalidateRequestCacheForPair(pair);
  return next;
}

export async function beginRequestSubmit(pair: RequestPair, launchSettings: DeepSeekLaunchSettings): Promise<SubmitArtifacts> {
  await ensureResponseWritable(pair, false);
  const updated = nowIso();
  await fs.writeFile(pair.responsePath, "", "utf8");
  await fs.writeFile(pair.reasoningPath, "", "utf8");
  await writeSubmitLease(pair, updated);
  await updateRequestVersionMeta(pair, { status: "pending", launchSettings, updated });
  await writeJsonFile(pair.responseJsonPath, { status: "pending", created: updated, updated } satisfies ResponseMeta);
  await writeJsonFile(pair.reasoningJsonPath, { status: "pending", created: updated, updated } satisfies ReasoningMeta);
  const meta = await readMeta(pair.requestDir);
  await writeMeta(pair.requestDir, { ...meta, updated });
  invalidateRequestCacheForPair(pair);
  return readSubmitArtifacts(pair);
}

export async function markRequestFilling(pair: RequestPair): Promise<void> {
  await touchRequestSubmitLease(pair);
  const requestMeta = await readJsonFile<RequestVersionMeta>(pair.requestJsonPath);
  if (requestMeta.status === "pending") {
    await updateRequestVersionMeta(pair, { status: "filling" });
  }
}

export async function completeRequestSubmit(pair: RequestPair): Promise<SubmitArtifacts> {
  const updated = nowIso();
  const responseStat = await statTextFile(pair.responsePath);
  const reasoningStat = await statTextFile(pair.reasoningPath);
  await updateRequestVersionMeta(pair, { status: "filled", updated });
  await updateResponseMeta(pair, { status: responseStat.size > 0 ? "filled" : "filled", updated });
  await updateReasoningMeta(pair, { status: reasoningStat.size > 0 ? "filled" : "empty", updated });
  const meta = await readMeta(pair.requestDir);
  await writeMeta(pair.requestDir, { ...meta, updated });
  await removeSubmitLease(pair);
  invalidateRequestCacheForPair(pair);
  return readSubmitArtifacts(pair);
}

export async function failRequestSubmit(pair: RequestPair, error: string, deepseekStatusCode?: number): Promise<SubmitArtifacts> {
  const updated = nowIso();
  await updateRequestVersionMeta(pair, {
    status: "error",
    error,
    ...(deepseekStatusCode !== undefined ? { deepseekStatusCode } : {}),
    updated,
  });
  if (await fileExists(pair.responseJsonPath)) {
    await updateResponseMeta(pair, { status: "error", error, updated });
  }
  if (await fileExists(pair.reasoningJsonPath)) {
    await updateReasoningMeta(pair, { status: "error", error, updated });
  }
  const meta = await readMeta(pair.requestDir);
  await writeMeta(pair.requestDir, { ...meta, updated });
  await removeSubmitLease(pair);
  invalidateRequestCacheForPair(pair);
  return readSubmitArtifacts(pair);
}

export async function appendResponseText(pair: RequestPair, text: string): Promise<void> {
  if (text.length === 0) {
    return;
  }
  await markRequestFilling(pair);
  await updateResponseMeta(pair, { status: "filling" });
  await fs.appendFile(pair.responsePath, text, "utf8");
  invalidateRequestCacheForPair(pair);
}

export async function appendReasoningText(pair: RequestPair, text: string): Promise<void> {
  if (text.length === 0) {
    return;
  }
  await markRequestFilling(pair);
  await updateReasoningMeta(pair, { status: "filling" });
  await fs.appendFile(pair.reasoningPath, text, "utf8");
  invalidateRequestCacheForPair(pair);
}

export async function readSubmitArtifacts(pair: RequestPair): Promise<SubmitArtifacts> {
  return {
    request: await requestObjectForPair(pair),
    response: await responseObjectForPair(pair),
    reasoning: await reasoningObjectForPair(pair),
  };
}

export async function requestVersions(id: string, dirInput?: string): Promise<RequestVersionSummary[]> {
  const location = await findRequestLocation(id, dirInput);
  if (!location) {
    throw new RequestStoreError(`Request ${id} was not found in active requests or archive.`, 404);
  }
  return requestScopedCache.getOrCompute(
    cacheScopeForLocation(location),
    "version-summaries",
    async () => {
      const meta = await readMetaForLocation(location);
      const versions = await listVersionNumbersForLocation(location);
      const latest = versions.at(-1);
      const result: RequestVersionSummary[] = [];
      for (const version of versions) {
        const pair = pathsForRequest(location, meta.title, version);
        const requestMeta = await readRequestVersionMetaForPair(pair);
        const requestStat = await statTextFileForPair(pair, "request");
        const responseMeta = await readOptionalResponseMetaForPair(pair);
        const responseStat = responseMeta ? await statOptionalTextFileForPair(pair, "response", !isRunningStatus(responseMeta.status)) : undefined;
        const reasoningMeta = await readOptionalReasoningMetaForPair(pair);
        const reasoningStat = reasoningMeta ? await statOptionalTextFileForPair(pair, "reasoning", !isRunningStatus(reasoningMeta.status)) : undefined;
        result.push({
          version,
          isCurrent: version === latest,
          requestStatus: requestMeta.status,
          requestSize: requestStat.size,
          requestTokens: requestStat.tokens,
          requestLines: requestStat.lines,
          ...(responseMeta ? { responseStatus: responseMeta.status } : {}),
          ...(responseStat ? { responseSize: responseStat.size, responseTokens: responseStat.tokens, responseLines: responseStat.lines } : {}),
          ...(reasoningMeta ? { reasoningStatus: reasoningMeta.status } : {}),
          ...(reasoningStat ? { reasoningSize: reasoningStat.size, reasoningTokens: reasoningStat.tokens, reasoningLines: reasoningStat.lines } : {}),
        });
      }
      return result;
    },
    (versions) =>
      versions.every(
        (version) =>
          !isRunningStatus(version.requestStatus) &&
          (version.responseStatus === undefined || !isRunningStatus(version.responseStatus)) &&
          (version.reasoningStatus === undefined || !isRunningStatus(version.reasoningStatus)),
      ),
  );
}

export function publicRequest(entry: DeepSeekRequest): DeepSeekRequest {
  return {
    id: entry.id,
    title: entry.title,
    created: entry.created,
    updated: entry.updated,
    version: entry.version,
    status: entry.status,
    size: entry.size,
    tokens: entry.tokens,
    lines: entry.lines,
    price: entry.price,
    archived: entry.archived,
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.deepseekStatusCode !== undefined ? { deepseekStatusCode: entry.deepseekStatusCode } : {}),
  };
}
