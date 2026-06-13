import { promises as fs } from "node:fs";
import { deflateRawSync } from "node:zlib";

export interface ZipTestEntry {
  path: string;
  content: string | Buffer;
  compression?: "store" | "deflate";
}

function writeUInt16(buffer: Buffer, value: number, offset: number): void {
  buffer.writeUInt16LE(value, offset);
}

function writeUInt32(buffer: Buffer, value: number, offset: number): void {
  buffer.writeUInt32LE(value, offset);
}

export function storedZipBuffer(entries: ZipTestEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const content = typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : entry.content;
    const compressionMethod = entry.compression === "deflate" ? 8 : 0;
    const storedContent = compressionMethod === 8 ? deflateRawSync(content) : content;
    const localOffset = offset;
    const local = Buffer.alloc(30 + name.length + storedContent.length);
    writeUInt32(local, 0x04034b50, 0);
    writeUInt16(local, 20, 4);
    writeUInt16(local, 0x0800, 6);
    writeUInt16(local, compressionMethod, 8);
    writeUInt16(local, 0, 10);
    writeUInt16(local, 0, 12);
    writeUInt32(local, 0, 14);
    writeUInt32(local, storedContent.length, 18);
    writeUInt32(local, content.length, 22);
    writeUInt16(local, name.length, 26);
    writeUInt16(local, 0, 28);
    name.copy(local, 30);
    storedContent.copy(local, 30 + name.length);
    localParts.push(local);
    offset += local.length;

    const central = Buffer.alloc(46 + name.length);
    writeUInt32(central, 0x02014b50, 0);
    writeUInt16(central, 20, 4);
    writeUInt16(central, 20, 6);
    writeUInt16(central, 0x0800, 8);
    writeUInt16(central, compressionMethod, 10);
    writeUInt16(central, 0, 12);
    writeUInt16(central, 0, 14);
    writeUInt32(central, 0, 16);
    writeUInt32(central, storedContent.length, 20);
    writeUInt32(central, content.length, 24);
    writeUInt16(central, name.length, 28);
    writeUInt16(central, 0, 30);
    writeUInt16(central, 0, 32);
    writeUInt16(central, 0, 34);
    writeUInt16(central, 0, 36);
    writeUInt32(central, 0, 38);
    writeUInt32(central, localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const eocd = Buffer.alloc(22);
  writeUInt32(eocd, 0x06054b50, 0);
  writeUInt16(eocd, 0, 4);
  writeUInt16(eocd, 0, 6);
  writeUInt16(eocd, entries.length, 8);
  writeUInt16(eocd, entries.length, 10);
  writeUInt32(eocd, centralSize, 12);
  writeUInt32(eocd, centralOffset, 16);
  writeUInt16(eocd, 0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

export async function writeStoredZip(filePath: string, entries: ZipTestEntry[]): Promise<void> {
  await fs.writeFile(filePath, storedZipBuffer(entries));
}
