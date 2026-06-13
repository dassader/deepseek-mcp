import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

const thisFile = fileURLToPath(import.meta.url);

function findPackageRoot(start: string): string {
  let cursor = start;
  for (;;) {
    const hasTokenizer = existsSync(path.join(cursor, "assets", "tokenizer.json")) || existsSync(path.join(cursor, "assets", "tokenizer.json.br"));
    if (hasTokenizer && existsSync(path.join(cursor, "package.json"))) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return path.resolve(start, "..", "..");
    }
    cursor = parent;
  }
}

export const packageRoot = findPackageRoot(path.dirname(thisFile));
export const defaultDataDir = path.resolve(process.cwd(), "data");

export function resolveUserPath(input: string | undefined, fallback: string): string {
  const raw = input && input.trim().length > 0 ? input : fallback;
  if (raw.startsWith("~/")) {
    return path.resolve(process.env.HOME ?? process.cwd(), raw.slice(2));
  }
  return path.resolve(raw);
}

export function displayPath(target: string): string {
  const resolved = path.resolve(target);
  const cwd = process.cwd();
  const relative = path.relative(cwd, resolved);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.length === 0 ? "." : relative;
  }
  return resolved;
}
