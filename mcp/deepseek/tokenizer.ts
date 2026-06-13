import { existsSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import path from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import { packageRoot } from "../shared/paths.js";

let tokenizer: Tokenizer | undefined;

function tokenizerPath(): { tokenizerJson: string; tokenizerConfig: string } {
  const defaultTokenizerJson = path.join(packageRoot, "assets", "tokenizer.json");
  const tokenizerJson =
    process.env.DEEPSEEK_TOKENIZER_JSON ??
    (existsSync(defaultTokenizerJson) ? defaultTokenizerJson : path.join(packageRoot, "assets", "tokenizer.json.br"));
  const tokenizerConfig = process.env.DEEPSEEK_TOKENIZER_CONFIG ?? path.join(packageRoot, "assets", "tokenizer_config.json");
  return { tokenizerJson, tokenizerConfig };
}

function readTokenizerJson(filePath: string): string {
  const bytes = readFileSync(filePath);
  return filePath.endsWith(".br") ? brotliDecompressSync(bytes).toString("utf8") : bytes.toString("utf8");
}

function loadTokenizer(): Tokenizer {
  if (tokenizer) {
    return tokenizer;
  }
  const paths = tokenizerPath();
  tokenizer = new Tokenizer(JSON.parse(readTokenizerJson(paths.tokenizerJson)), JSON.parse(readFileSync(paths.tokenizerConfig, "utf8")));
  return tokenizer;
}

export function encodeText(text: string): number[] {
  return loadTokenizer().encode(text, false).ids;
}

export function countTextTokens(text: string): number {
  return encodeText(text).length;
}

export function tokenizerDescription(): string {
  return "deepseek_tokenizer-0.2.0 tokenizer.json(.br) + DeepSeek-V4 formatting";
}

export function resetTokenizerForTests(): void {
  tokenizer = undefined;
}
