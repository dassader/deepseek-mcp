import { promises as fs } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { TextDecoder } from "node:util";
import { RequestStoreError, appendRequestContent, type DeepSeekRequest } from "./archive.js";
import { resolveUserPath } from "../shared/paths.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP64_SIZE = 0xffffffff;
const MAX_EOCD_SEARCH_BYTES = 65_557;
const MAX_ZIP_FILES = 2_000;
const MAX_ZIP_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 50 * 1024 * 1024;

export type ZipBinaryPolicy = "reject" | "skip";

export interface RequestZipSource {
  zipPath?: string;
  zipBase64?: string;
  binaryPolicy?: ZipBinaryPolicy;
}

export interface ZipAppendedFile {
  path: string;
  bytes: number;
  chars: number;
}

export interface ZipSkippedFile {
  path: string;
  reason: string;
}

export interface AppendZipRequestResult {
  request: DeepSeekRequest;
  version: number;
  files: ZipAppendedFile[];
  skippedFiles: ZipSkippedFile[];
  totalBytes: number;
  totalChars: number;
}

interface ZipEntry {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  flags: number;
  localHeaderOffset: number;
}

interface TextEntry extends ZipAppendedFile {
  content: string;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function readUInt32(buffer: Buffer, offset: number): number {
  if (offset + 4 > buffer.length) {
    throw new RequestStoreError("ZIP archive is truncated.", 400);
  }
  return buffer.readUInt32LE(offset);
}

function readUInt16(buffer: Buffer, offset: number): number {
  if (offset + 2 > buffer.length) {
    throw new RequestStoreError("ZIP archive is truncated.", 400);
  }
  return buffer.readUInt16LE(offset);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - MAX_EOCD_SEARCH_BYTES);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new RequestStoreError("ZIP archive does not contain an end-of-central-directory record.", 400);
}

function normalizedZipPath(rawName: string): string {
  const name = rawName.replace(/\\/g, "/").replace(/^\/+/u, "");
  if (name.length === 0 || name.includes("\0")) {
    throw new RequestStoreError("ZIP archive contains an empty or invalid file path.", 400);
  }
  const parts = name.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new RequestStoreError(`ZIP archive contains an unsafe relative path: ${JSON.stringify(rawName)}.`, 400);
  }
  if (/^[a-zA-Z]:/u.test(parts[0] ?? "")) {
    throw new RequestStoreError(`ZIP archive contains an absolute Windows path: ${JSON.stringify(rawName)}.`, 400);
  }
  return parts.join("/");
}

function readCentralDirectory(buffer: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = readUInt16(buffer, eocdOffset + 4);
  const centralDiskNumber = readUInt16(buffer, eocdOffset + 6);
  const entriesOnDisk = readUInt16(buffer, eocdOffset + 8);
  const totalEntries = readUInt16(buffer, eocdOffset + 10);
  const centralSize = readUInt32(buffer, eocdOffset + 12);
  const centralOffset = readUInt32(buffer, eocdOffset + 16);

  if (diskNumber !== 0 || centralDiskNumber !== 0 || entriesOnDisk !== totalEntries) {
    throw new RequestStoreError("Multi-disk ZIP archives are not supported.", 400);
  }
  if (totalEntries > MAX_ZIP_FILES) {
    throw new RequestStoreError(`ZIP archive has ${totalEntries} files; the safety limit is ${MAX_ZIP_FILES}.`, 413);
  }
  if (centralOffset === ZIP64_SIZE || centralSize === ZIP64_SIZE || totalEntries === 0xffff) {
    throw new RequestStoreError("ZIP64 archives are not supported by request_append_zip.", 400);
  }
  if (centralOffset + centralSize > buffer.length || centralOffset > eocdOffset) {
    throw new RequestStoreError("ZIP archive central directory is invalid.", 400);
  }

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (readUInt32(buffer, offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new RequestStoreError("ZIP archive central directory entry is invalid.", 400);
    }
    const flags = readUInt16(buffer, offset + 8);
    const compressionMethod = readUInt16(buffer, offset + 10);
    const compressedSize = readUInt32(buffer, offset + 20);
    const uncompressedSize = readUInt32(buffer, offset + 24);
    const nameLength = readUInt16(buffer, offset + 28);
    const extraLength = readUInt16(buffer, offset + 30);
    const commentLength = readUInt16(buffer, offset + 32);
    const localHeaderOffset = readUInt32(buffer, offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const nextOffset = nameEnd + extraLength + commentLength;
    if (nextOffset > buffer.length) {
      throw new RequestStoreError("ZIP archive central directory entry is truncated.", 400);
    }

    const rawName = Buffer.from(buffer.subarray(nameStart, nameEnd)).toString("utf8");
    offset = nextOffset;
    if (rawName.endsWith("/")) {
      continue;
    }
    if ((flags & 0x1) !== 0) {
      throw new RequestStoreError(`ZIP entry ${JSON.stringify(rawName)} is encrypted; encrypted archives are not supported.`, 400);
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new RequestStoreError(`ZIP entry ${JSON.stringify(rawName)} uses unsupported compression method ${compressionMethod}.`, 400);
    }
    if (compressedSize === ZIP64_SIZE || uncompressedSize === ZIP64_SIZE || localHeaderOffset === ZIP64_SIZE) {
      throw new RequestStoreError("ZIP64 entries are not supported by request_append_zip.", 400);
    }
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
      throw new RequestStoreError(`ZIP entry ${JSON.stringify(rawName)} is larger than the ${MAX_ZIP_ENTRY_BYTES} byte per-file safety limit.`, 413);
    }
    const safePath = normalizedZipPath(rawName);
    if (seen.has(safePath)) {
      throw new RequestStoreError(`ZIP archive contains duplicate file path ${JSON.stringify(safePath)}.`, 400);
    }
    seen.add(safePath);
    entries.push({ path: safePath, compressedSize, uncompressedSize, compressionMethod, flags, localHeaderOffset });
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function inflateEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  if (readUInt32(buffer, entry.localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
    throw new RequestStoreError(`ZIP local header is missing for ${JSON.stringify(entry.path)}.`, 400);
  }
  const localNameLength = readUInt16(buffer, entry.localHeaderOffset + 26);
  const localExtraLength = readUInt16(buffer, entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart > buffer.length || dataEnd > buffer.length) {
    throw new RequestStoreError(`ZIP entry ${JSON.stringify(entry.path)} data is truncated.`, 400);
  }

  const compressed = buffer.subarray(dataStart, dataEnd);
  const content = entry.compressionMethod === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
  if (content.length !== entry.uncompressedSize) {
    throw new RequestStoreError(`ZIP entry ${JSON.stringify(entry.path)} has an invalid uncompressed size.`, 400);
  }
  return content;
}

function decodeTextEntry(entry: ZipEntry, content: Buffer, binaryPolicy: ZipBinaryPolicy): TextEntry | ZipSkippedFile {
  if (content.includes(0)) {
    if (binaryPolicy === "skip") {
      return { path: entry.path, reason: "contains NUL bytes" };
    }
    throw new RequestStoreError(`ZIP entry ${JSON.stringify(entry.path)} looks binary because it contains NUL bytes. Rebuild the archive with text files only or use binaryPolicy=skip.`, 400);
  }
  try {
    const text = utf8Decoder.decode(content);
    return {
      path: entry.path,
      bytes: content.length,
      chars: text.length,
      content: text,
    };
  } catch {
    if (binaryPolicy === "skip") {
      return { path: entry.path, reason: "not valid UTF-8 text" };
    }
    throw new RequestStoreError(`ZIP entry ${JSON.stringify(entry.path)} is not valid UTF-8 text. Rebuild the archive with text files only or use binaryPolicy=skip.`, 400);
  }
}

function zipAppendText(entries: TextEntry[]): string {
  return entries.map((entry) => `${entry.path}\n\n${entry.content}`).join("\n\n");
}

async function zipBufferFromSource(source: RequestZipSource): Promise<Buffer> {
  const hasPath = typeof source.zipPath === "string" && source.zipPath.trim().length > 0;
  const hasBase64 = typeof source.zipBase64 === "string" && source.zipBase64.trim().length > 0;
  if (hasPath === hasBase64) {
    throw new RequestStoreError("Provide exactly one ZIP source: zipPath for a server-local file or zipBase64 for inline ZIP bytes.", 400);
  }
  if (hasPath) {
    return fs.readFile(resolveUserPath(source.zipPath, ""));
  }
  return Buffer.from(source.zipBase64 ?? "", "base64");
}

export async function readZipTextEntries(source: RequestZipSource): Promise<{ files: TextEntry[]; skippedFiles: ZipSkippedFile[] }> {
  const zipBuffer = await zipBufferFromSource(source);
  const binaryPolicy = source.binaryPolicy ?? "reject";
  const entries = readCentralDirectory(zipBuffer);
  let totalBytes = 0;
  const files: TextEntry[] = [];
  const skippedFiles: ZipSkippedFile[] = [];

  for (const entry of entries) {
    totalBytes += entry.uncompressedSize;
    if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
      throw new RequestStoreError(`ZIP archive expands beyond the ${MAX_ZIP_TOTAL_BYTES} byte total safety limit.`, 413);
    }
    const decoded = decodeTextEntry(entry, inflateEntry(zipBuffer, entry), binaryPolicy);
    if ("content" in decoded) {
      files.push(decoded);
    } else {
      skippedFiles.push(decoded);
    }
  }
  if (files.length === 0) {
    throw new RequestStoreError("ZIP archive did not contain any UTF-8 text files to append.", 400);
  }
  return { files, skippedFiles };
}

export async function appendRequestZip(id: string, source: RequestZipSource, dirInput?: string): Promise<AppendZipRequestResult> {
  const { files, skippedFiles } = await readZipTextEntries(source);
  const appended = await appendRequestContent(id, zipAppendText(files), dirInput);
  return {
    request: appended.request,
    version: appended.version,
    files: files.map(({ path, bytes, chars }) => ({ path, bytes, chars })),
    skippedFiles,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    totalChars: files.reduce((total, file) => total + file.chars, 0),
  };
}
