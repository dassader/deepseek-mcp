import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequestFile, readReasoningResource, readRequestResource, readResponseResource, resolveActiveRequestPair, updateRequestContent } from "../mcp/archive/archive.js";
import { sendAndArchive, type ProgressEvent } from "../mcp/deepseek/client.js";
import { buildPayload } from "../mcp/deepseek/payload.js";

test("sendAndArchive stores DeepSeek response and reasoning on the submitted version", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-client-"));
  const created = await createRequestFile("Saving returned reasoning", dir);
  await updateRequestContent(created.id, "hello", dir);
  const pair = await resolveActiveRequestPair(created.id, dir);
  const payload = buildPayload("hello", {
    model: "deepseek-v4-pro",
    stream: false,
  });
  const oldApiKey = process.env.DEEPSEEK_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.DEEPSEEK_API_KEY = "test-key";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              reasoning_content: "private model reasoning",
              content: "public answer",
            },
          },
        ],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 5,
          total_tokens: 8,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    const result = await sendAndArchive(
      payload,
      pair,
      { source: "mcp-archived-request", requestedOptions: { model: "deepseek-v4-pro" }, effectiveApiParameters: { model: "deepseek-v4-pro" } },
      { stream: false },
    );

    const request = await readRequestResource(pair.id, dir, pair.version);
    const response = await readResponseResource(pair.id, dir, pair.version);
    const reasoning = await readReasoningResource(pair.id, dir, pair.version);
    assert.equal(result.responseText, "public answer");
    assert.equal(result.reasoningText, "private model reasoning");
    assert.equal(request.request.status, "filled");
    assert.equal(response.response.status, "filled");
    assert.equal(response.content, "public answer");
    assert.equal(response.response.price.model, "deepseek-v4-pro");
    assert.equal(response.response.price.outputTokens, response.response.tokens);
    assert.equal(reasoning.reasoning.status, "filled");
    assert.equal(reasoning.content, "private model reasoning");
    assert.equal(reasoning.reasoning.price.model, "deepseek-v4-pro");
    assert.equal(reasoning.reasoning.price.outputTokens, reasoning.reasoning.tokens);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldApiKey;
  }
});

test("sendAndArchive reports upload and download byte progress without response preview content", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-client-progress-"));
  const created = await createRequestFile("Streaming progress telemetry", dir);
  await updateRequestContent(created.id, "hello", dir);
  const pair = await resolveActiveRequestPair(created.id, dir);
  const payload = buildPayload("hello", {
    model: "deepseek-v4-pro",
    stream: true,
    includeUsage: true,
  });
  const oldApiKey = process.env.DEEPSEEK_API_KEY;
  const oldFetch = globalThis.fetch;
  const progressEvents: ProgressEvent[] = [];
  let upstreamPayloadBytes = 0;
  process.env.DEEPSEEK_API_KEY = "test-key";
  globalThis.fetch = async (_input, init) => {
    assert.ok(init?.body);
    upstreamPayloadBytes = Buffer.from(await new Response(init.body).arrayBuffer()).byteLength;
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "мысль", content: "ответ" } }] })}`,
      "",
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  try {
    const result = await sendAndArchive(
      payload,
      pair,
      { source: "mcp-archived-request", requestedOptions: { model: "deepseek-v4-pro" }, effectiveApiParameters: { model: "deepseek-v4-pro" } },
      {
        stream: true,
        progress: (event) => {
          progressEvents.push({ ...event });
        },
      },
    );

    const uploadEvents = progressEvents.filter((event) => event.phase === "upload");
    const downloadEvents = progressEvents.filter((event) => event.phase === "download");
    const lastUpload = uploadEvents.at(-1);
    const lastDownload = downloadEvents.at(-1);
    assert.ok(lastUpload);
    assert.equal(lastUpload.uploadedBytes, upstreamPayloadBytes);
    assert.equal(lastUpload.uploadTotalBytes, upstreamPayloadBytes);
    assert.equal(lastUpload.reasoningBytes, 0);
    assert.equal(lastUpload.responseBytes, 0);
    assert.ok(lastUpload.uploadBytesPerSecond > 0);
    assert.ok(lastDownload);
    assert.equal(lastDownload.reasoningBytes, Buffer.byteLength("мысль", "utf8"));
    assert.equal(lastDownload.responseBytes, Buffer.byteLength("ответ", "utf8"));
    assert.equal(result.responseText, "ответ");
    assert.equal(result.reasoningText, "мысль");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldApiKey;
  }
});
