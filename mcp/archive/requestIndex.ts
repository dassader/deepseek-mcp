import { promises as fs } from "node:fs";
import path from "node:path";

export const INDEX_DIR_NAME = "index";
export const REQUEST_INDEX_DIR_NAME = "requests";

const STALE_LOCK_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const REQUEST_INDEX_HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{2}$/u;

export interface RequestCreationIndexQuery {
  createdAfter?: string;
  createdBefore?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid request creation time: ${value}`);
  }
  return date;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function floorUtcHour(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), value.getUTCHours()));
}

export function requestCreationIndexKey(value: Date | string): string {
  const date = typeof value === "string" ? validDate(value) : value;
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}_${pad2(date.getUTCHours())}`;
}

export function requestCreationIndexDir(rootDir: string): string {
  return path.join(rootDir, INDEX_DIR_NAME, REQUEST_INDEX_DIR_NAME);
}

export function requestCreationIndexFilePath(rootDir: string, created: Date | string): string {
  return path.join(requestCreationIndexDir(rootDir), requestCreationIndexKey(created));
}

export function requestCreationIndexBackfillMarkerPath(rootDir: string): string {
  return path.join(requestCreationIndexDir(rootDir), ".backfilled");
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs <= STALE_LOCK_MS) {
      return false;
    }
    await fs.unlink(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

async function withIndexFileLock<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      await fs.writeFile(lockPath, `${process.pid}\n${new Date().toISOString()}\n`, { encoding: "utf8", flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      await removeStaleLock(lockPath);
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for request index lock: ${lockPath}`);
      }
      await sleep(12 + Math.floor(Math.random() * 24));
    }
  }

  try {
    return await run();
  } finally {
    try {
      await fs.unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

export async function appendRequestCreationIndex(rootDir: string, created: string, id: string): Promise<void> {
  const indexDir = requestCreationIndexDir(rootDir);
  const filePath = requestCreationIndexFilePath(rootDir, created);
  await fs.mkdir(indexDir, { recursive: true });
  await withIndexFileLock(filePath, async () => {
    await fs.appendFile(filePath, `${id}\n`, { encoding: "utf8", flag: "a" });
  });
}

export async function withRequestCreationIndexMaintenanceLock<T>(rootDir: string, run: () => Promise<T>): Promise<T> {
  const indexDir = requestCreationIndexDir(rootDir);
  await fs.mkdir(indexDir, { recursive: true });
  return withIndexFileLock(path.join(indexDir, ".maintenance"), run);
}

function indexHoursForQuery(query: RequestCreationIndexQuery): string[] | undefined {
  if (query.createdAfter === undefined) {
    return undefined;
  }
  const after = validDate(query.createdAfter);
  const before = query.createdBefore === undefined ? new Date() : validDate(query.createdBefore);
  if (after.getTime() > before.getTime()) {
    return [];
  }

  const hours: string[] = [];
  for (let current = floorUtcHour(after); current.getTime() <= before.getTime(); current = new Date(current.getTime() + 60 * 60 * 1000)) {
    hours.push(requestCreationIndexKey(current));
  }
  return hours;
}

export async function readRequestCreationIndexIds(rootDir: string, query: RequestCreationIndexQuery): Promise<string[] | undefined> {
  const hours = indexHoursForQuery(query);
  if (hours === undefined) {
    return undefined;
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const hour of hours) {
    if (!REQUEST_INDEX_HOUR_PATTERN.test(hour)) {
      continue;
    }
    const filePath = path.join(requestCreationIndexDir(rootDir), hour);
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const line of text.split(/\r?\n/u)) {
      const id = line.trim();
      if (id.length > 0 && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}
