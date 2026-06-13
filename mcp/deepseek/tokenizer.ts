import { readFileSync } from "node:fs";
import path from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import { packageRoot } from "../shared/paths.js";

let tokenizer: Tokenizer | undefined;

function tokenizerPath(): { tokenizerJson: string; tokenizerConfig: string } {
  const tokenizerJson = process.env.DEEPSEEK_TOKENIZER_JSON ?? path.join(packageRoot, "assets", "tokenizer.json");
  const tokenizerConfig = process.env.DEEPSEEK_TOKENIZER_CONFIG ?? path.join(packageRoot, "assets", "tokenizer_config.json");
  return { tokenizerJson, tokenizerConfig };
}

function loadTokenizer(): Tokenizer {
  if (tokenizer) {
    return tokenizer;
  }
  const paths = tokenizerPath();
  tokenizer = new Tokenizer(JSON.parse(readFileSync(paths.tokenizerJson, "utf8")), JSON.parse(readFileSync(paths.tokenizerConfig, "utf8")));
  return tokenizer;
}

export function encodeText(text: string): number[] {
  return loadTokenizer().encode(text, false).ids;
}

export function countTextTokens(text: string): number {
  return encodeText(text).length;
}

export function tokenizerDescription(): string {
  return "deepseek_tokenizer-0.2.0 tokenizer.json + DeepSeek-V4 formatting";
}
