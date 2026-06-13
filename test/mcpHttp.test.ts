import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMcpHttpServer } from "../mcp/http/mcpHttp.js";
import { describeMcpHttp, mcpHttpConfigFromEnv } from "../mcp/http/mcpHttpConfig.js";

test("MCP HTTP config describes stateless streamable endpoint", () => {
  const config = mcpHttpConfigFromEnv({
    DEEPSEEK_MCP_HTTP_ENABLED: "true",
    DEEPSEEK_MCP_HTTP_HOST: "192.168.1.20",
    DEEPSEEK_MCP_HTTP_PORT: "8788",
    DEEPSEEK_MCP_HTTP_PATH: "mcp",
  });
  const description = describeMcpHttp(config, true);

  assert.equal(description.enabled, true);
  assert.equal(description.path, "/mcp");
  assert.deepEqual(description.endpointUrls, ["http://192.168.1.20:8788/mcp"]);
  assert.equal(description.sessionMode, "stateless per HTTP request");
});

test("MCP HTTP exposes tools through JSON-RPC", async () => {
  const server = startMcpHttpServer({
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
  });
  assert.ok(server);

  try {
    await once(server, "listening");
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    const info = address as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${info.port}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result?: { tools?: Array<{ name?: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } }> } };

    const toolNames = body.result?.tools?.map((tool) => String(tool.name)).sort() ?? [];
    assert.deepEqual(toolNames, [
      "capabilities",
      "reasoning_read",
      "request_append",
      "request_append_zip",
      "request_archive",
      "request_batch",
      "request_create",
      "request_list",
      "request_read",
      "request_submit",
      "request_update",
      "request_versions",
      "response_read",
    ]);
    assert.equal(toolNames.some((name) => name.startsWith("deepseek_")), false);
    assert.ok(body.result?.tools?.some((tool) => tool.name === "request_create"));
    assert.ok(body.result?.tools?.some((tool) => tool.name === "request_update"));
    assert.ok(body.result?.tools?.some((tool) => tool.name === "request_append"));
    const requestAppendZip = body.result?.tools?.find((tool) => tool.name === "request_append_zip");
    assert.ok(requestAppendZip);
    const requestList = body.result?.tools?.find((tool) => tool.name === "request_list");
    assert.ok(requestList);
    assert.ok(Object.hasOwn(requestList.inputSchema?.properties ?? {}, "createdAfter"));
    assert.ok(Object.hasOwn(requestList.inputSchema?.properties ?? {}, "createdBefore"));
    const requestSubmit = body.result?.tools?.find((tool) => tool.name === "request_submit");
    assert.ok(requestSubmit);
    const requestBatch = body.result?.tools?.find((tool) => tool.name === "request_batch");
    assert.ok(requestBatch);
    for (const tool of body.result?.tools ?? []) {
      assert.equal(Object.hasOwn(tool.inputSchema?.properties ?? {}, "archiveDir"), false, `${tool.name ?? "unknown"} exposes archiveDir`);
    }
    assert.equal(Object.hasOwn(requestList.inputSchema?.properties ?? {}, "scope"), false);

    const properties = requestSubmit.inputSchema?.properties ?? {};
    assert.deepEqual(Object.keys(properties).sort(), [
      "id",
      "maxTokens",
      "model",
      "progressInterval",
      "reasoning",
      "reserveOutputTokens",
      "responseFormat",
      "safetyMarginTokens",
      "temperature",
      "thinking",
    ]);
    assert.deepEqual((properties.model as { enum?: unknown }).enum, ["deepseek-v4-flash", "deepseek-v4-pro"]);
    assert.deepEqual((properties.thinking as { enum?: unknown }).enum, ["enabled", "disabled"]);
    assert.deepEqual((properties.reasoning as { enum?: unknown }).enum, ["high", "max"]);
    assert.equal((properties.maxTokens as { default?: unknown }).default, 384000);
    assert.match(String((properties.reasoning as { description?: unknown }).description), /reasoning_effort/);

    const batchProperties = requestBatch.inputSchema?.properties ?? {};
    assert.deepEqual(Object.keys(batchProperties).sort(), [
      "ids",
      "maxTokens",
      "model",
      "progressInterval",
      "reasoning",
      "reserveOutputTokens",
      "responseFormat",
      "safetyMarginTokens",
      "temperature",
      "thinking",
    ]);
    assert.match(String(requestBatch.description), /Batch: 4 Active: 3 Finished: 1 Error: 0 Reasoning: 17472 Response: 46363/);

    const appendZipProperties = requestAppendZip.inputSchema?.properties ?? {};
    assert.deepEqual(Object.keys(appendZipProperties).sort(), ["binaryPolicy", "id", "zipBase64", "zipPath"]);
    assert.deepEqual((appendZipProperties.binaryPolicy as { enum?: unknown }).enum, ["reject", "skip"]);
    assert.match(String((appendZipProperties.zipPath as { description?: unknown }).description), /Server-local path/);
    assert.match(String(requestAppendZip.description), /relative\/path/);
    assert.match(String(requestAppendZip.description), /exclude build outputs/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("MCP HTTP exposes static resources through JSON-RPC", async () => {
  const server = startMcpHttpServer({
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
  });
  assert.ok(server);

  try {
    await once(server, "listening");
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    const info = address as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${info.port}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "resources/list",
        params: {},
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result?: { resources?: Array<{ name?: string; uri?: string }> } };
    const resources = body.result?.resources ?? [];
    const resourceNames = resources.map((resource) => String(resource.name));
    const resourceUris = resources.map((resource) => String(resource.uri));

    assert.ok(resourceNames.includes("account_balance"));
    assert.ok(resourceNames.includes("instructions"));
    assert.ok(resourceNames.includes("models"));
    assert.ok(resourceUris.includes("deepseek://account_balance"));
    assert.ok(resourceUris.includes("deepseek://instructions"));
    assert.ok(resourceUris.includes("deepseek://models"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("UI API exposes account balance without exposing the API key", async () => {
  const oldApiKey = process.env.DEEPSEEK_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.DEEPSEEK_API_KEY = "ui-balance-secret";
  const server = startMcpHttpServer({
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
  });
  assert.ok(server);

  try {
    await once(server, "listening");
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    const info = address as AddressInfo;
    const endpoint = `http://127.0.0.1:${info.port}`;
    let authorizationHeader = "";
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(endpoint)) {
        return oldFetch(input, init);
      }
      const headers = new Headers(init?.headers);
      authorizationHeader = headers.get("authorization") ?? "";
      return new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [
            {
              currency: "USD",
              total_balance: "12.34",
              granted_balance: "2.00",
              topped_up_balance: "10.34",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const response = await fetch(`${endpoint}/api/ui/account-balance`);
    assert.equal(response.status, 200);
    const bodyText = await response.text();
    const body = JSON.parse(bodyText) as { data?: { balanceInfos?: Array<{ currency?: string; totalBalance?: string }> } };

    assert.equal(authorizationHeader, "Bearer ui-balance-secret");
    assert.equal(body.data?.balanceInfos?.[0]?.currency, "USD");
    assert.equal(body.data?.balanceInfos?.[0]?.totalBalance, "12.34");
    assert.equal(bodyText.includes("ui-balance-secret"), false);
  } finally {
    globalThis.fetch = oldFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (oldApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldApiKey;
  }
});

test("MCP HTTP models resource returns only model specs", async () => {
  const server = startMcpHttpServer({
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
  });
  assert.ok(server);

  try {
    await once(server, "listening");
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    const info = address as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${info.port}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "resources/read",
        params: {
          uri: "deepseek://models",
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result?: { contents?: Array<{ text?: string }> } };
    const models = JSON.parse(body.result?.contents?.[0]?.text ?? "null") as Array<{ name?: string }>;

    assert.deepEqual(
      models.map((model) => model.name),
      ["deepseek-v4-flash", "deepseek-v4-pro"],
    );
    assert.equal(Object.hasOwn(models as unknown as Record<string, unknown>, "server"), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("MCP HTTP exposes canonical request resource templates", async () => {
  const server = startMcpHttpServer({
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
  });
  assert.ok(server);

  try {
    await once(server, "listening");
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    const info = address as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${info.port}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/templates/list",
        params: {},
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result?: { resourceTemplates?: Array<{ uriTemplate?: string }> } };
    const templates = body.result?.resourceTemplates?.map((template) => template.uriTemplate) ?? [];

    assert.ok(templates.includes("deepseek://request/{id}{?version}"));
    assert.ok(templates.includes("deepseek://response/{id}{?version}"));
    assert.ok(templates.includes("deepseek://reasoning/{id}{?version}"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("request_append tool returns the request object without createdVersion noise", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-http-"));
  const oldDataDir = process.env.DEEPSEEK_DATA_DIR;
  process.env.DEEPSEEK_DATA_DIR = dir;
  const server = startMcpHttpServer({
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
  });
  assert.ok(server);

  try {
    await once(server, "listening");
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    const info = address as AddressInfo;
    const endpoint = `http://127.0.0.1:${info.port}/mcp`;
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    };

    const createResponse = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "request_create",
          arguments: { title: "Append shape" },
        },
      }),
    });
    const createBody = (await createResponse.json()) as { result?: { structuredContent?: { data?: { id?: string } } } };
    const id = createBody.result?.structuredContent?.data?.id;
    assert.equal(typeof id, "string");

    const appendResponse = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "request_append",
          arguments: { id, content: "hello" },
        },
      }),
    });
    const appendBody = (await appendResponse.json()) as { result?: { structuredContent?: { data?: Record<string, unknown> } } };
    const data = appendBody.result?.structuredContent?.data ?? {};

    assert.equal(data.id, id);
    assert.equal(data.version, 0);
    assert.equal(data.status, "draft");
    assert.equal("createdVersion" in data, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (oldDataDir === undefined) delete process.env.DEEPSEEK_DATA_DIR;
    else process.env.DEEPSEEK_DATA_DIR = oldDataDir;
  }
});

test("request_submit saves response without returning preview text", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-http-submit-"));
  const oldDataDir = process.env.DEEPSEEK_DATA_DIR;
  const oldApiKey = process.env.DEEPSEEK_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.DEEPSEEK_DATA_DIR = dir;
  process.env.DEEPSEEK_API_KEY = "test-key";
  const server = startMcpHttpServer({
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
  });
  assert.ok(server);

  try {
    await once(server, "listening");
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    const info = address as AddressInfo;
    const endpoint = `http://127.0.0.1:${info.port}/mcp`;
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    };
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(endpoint)) {
        return oldFetch(input, init);
      }
      assert.ok(init?.body);
      await new Response(init.body).arrayBuffer();
      const sse = [
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "private reasoning", content: "public answer" } }] })}`,
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

    const createResponse = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "request_create",
          arguments: { title: "Submit shape" },
        },
      }),
    });
    const createBody = (await createResponse.json()) as { result?: { structuredContent?: { data?: { id?: string } } } };
    const id = createBody.result?.structuredContent?.data?.id;
    assert.equal(typeof id, "string");

    await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "request_append",
          arguments: { id, content: "hello" },
        },
      }),
    });

    const submitResponse = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "request_submit",
          arguments: { id, progressInterval: 0 },
        },
      }),
    });
    const submitBody = (await submitResponse.json()) as { result?: { structuredContent?: { data?: Record<string, unknown> } } };
    const data = submitBody.result?.structuredContent?.data ?? {};

    assert.equal("preview" in data, false);
    assert.equal(JSON.stringify(data).includes("public answer"), false);
    assert.equal((data.response as { status?: unknown } | undefined)?.status, "filled");
  } finally {
    globalThis.fetch = oldFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (oldDataDir === undefined) delete process.env.DEEPSEEK_DATA_DIR;
    else process.env.DEEPSEEK_DATA_DIR = oldDataDir;
    if (oldApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldApiKey;
  }
});

test("request_batch submits active requests concurrently and returns per-request metadata", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-http-batch-"));
  const oldDataDir = process.env.DEEPSEEK_DATA_DIR;
  const oldApiKey = process.env.DEEPSEEK_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.DEEPSEEK_DATA_DIR = dir;
  process.env.DEEPSEEK_API_KEY = "test-key";
  const server = startMcpHttpServer({
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
  });
  assert.ok(server);

  try {
    await once(server, "listening");
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    const info = address as AddressInfo;
    const endpoint = `http://127.0.0.1:${info.port}/mcp`;
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    };
    let inFlight = 0;
    let maxInFlight = 0;
    let upstreamCalls = 0;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(endpoint)) {
        return oldFetch(input, init);
      }
      assert.ok(init?.body);
      await new Response(init.body).arrayBuffer();
      upstreamCalls += 1;
      const call = upstreamCalls;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      const sse = [
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: `reasoning ${call}`, content: `answer ${call}` } }] })}`,
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

    async function callTool<T>(rpcId: number, name: string, args: Record<string, unknown>): Promise<T> {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: rpcId,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { result?: { structuredContent?: { data?: T } } };
      return body.result?.structuredContent?.data as T;
    }

    const first = await callTool<{ id?: string }>(10, "request_create", { title: "Batch first" });
    const second = await callTool<{ id?: string }>(11, "request_create", { title: "Batch second" });
    assert.equal(typeof first.id, "string");
    assert.equal(typeof second.id, "string");
    await callTool(12, "request_append", { id: first.id, content: "hello first" });
    await callTool(13, "request_append", { id: second.id, content: "hello second" });

    const batch = await callTool<{
      batch?: { total?: number; active?: number; finished?: number; error?: number; reasoningBytes?: number; responseBytes?: number };
      results?: Array<{ id?: string; ok?: boolean; status?: string; reasoningBytes?: number; responseBytes?: number }>;
    }>(14, "request_batch", { ids: [first.id, second.id], progressInterval: 0 });

    assert.equal(upstreamCalls, 2);
    assert.equal(maxInFlight, 2);
    assert.equal(batch.batch?.total, 2);
    assert.equal(batch.batch?.active, 0);
    assert.equal(batch.batch?.finished, 2);
    assert.equal(batch.batch?.error, 0);
    assert.equal(batch.results?.length, 2);
    assert.deepEqual(
      batch.results?.map((result) => result.ok),
      [true, true],
    );
    assert.deepEqual(
      batch.results?.map((result) => result.status),
      ["finished", "finished"],
    );
    assert.equal(JSON.stringify(batch).includes("answer 1"), false);
    assert.equal(JSON.stringify(batch).includes("answer 2"), false);
    assert.ok((batch.batch?.reasoningBytes ?? 0) > 0);
    assert.ok((batch.batch?.responseBytes ?? 0) > 0);
  } finally {
    globalThis.fetch = oldFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (oldDataDir === undefined) delete process.env.DEEPSEEK_DATA_DIR;
    else process.env.DEEPSEEK_DATA_DIR = oldDataDir;
    if (oldApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldApiKey;
  }
});

test("UI API lists, searches, archives, restores, and serves the Preact shell", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-ui-"));
  const oldDataDir = process.env.DEEPSEEK_DATA_DIR;
  process.env.DEEPSEEK_DATA_DIR = dir;
  const server = startMcpHttpServer({
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
  });
  assert.ok(server);

  try {
    await once(server, "listening");
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    const info = address as AddressInfo;
    const endpoint = `http://127.0.0.1:${info.port}`;
    const mcpHeaders = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    };

    async function callTool<T>(rpcId: number, name: string, args: Record<string, unknown>): Promise<T> {
      const response = await fetch(`${endpoint}/mcp`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: rpcId,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { result?: { structuredContent?: { data?: T } } };
      return body.result?.structuredContent?.data as T;
    }

    async function ui<T>(pathInput: string, init?: RequestInit): Promise<T> {
      const response = await fetch(`${endpoint}${pathInput}`, init);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { data?: T };
      return body.data as T;
    }

    const empty = await callTool<{ id?: string }>(20, "request_create", { title: "Empty UI request" });
    assert.equal(typeof empty.id, "string");
    const emptyDetail = await ui<{ versions: Array<{ version?: number }> }>(`/api/ui/requests/${empty.id}`);
    assert.deepEqual(emptyDetail.versions.map((version) => version.version), []);

    const created = await callTool<{ id?: string }>(21, "request_create", { title: "UI search target" });
    assert.equal(typeof created.id, "string");
    await callTool(22, "request_append", { id: created.id, content: "needle-full-text-content" });
    const filledInitialDetail = await ui<{ versions: Array<{ version?: number; displayVersion?: number }> }>(`/api/ui/requests/${created.id}`);
    assert.deepEqual(filledInitialDetail.versions.map((version) => version.version), [0]);
    assert.deepEqual(filledInitialDetail.versions.map((version) => version.displayVersion), [1]);
    const filledInitialVersion = await ui<{ request?: { request?: { version?: number; displayVersion?: number } } }>(`/api/ui/requests/${created.id}/versions/0`);
    assert.equal(filledInitialVersion.request?.request?.version, 0);
    assert.equal(filledInitialVersion.request?.request?.displayVersion, 1);

    const shifted = await callTool<{ id?: string }>(23, "request_create", { title: "UI shifted version target" });
    assert.equal(typeof shifted.id, "string");
    await callTool(24, "request_update", { id: shifted.id, content: "version-one-after-empty-v0" });
    const shiftedDetail = await ui<{ request?: { displayVersion?: number }; versions: Array<{ version?: number; displayVersion?: number }> }>(`/api/ui/requests/${shifted.id}`);
    assert.equal(shiftedDetail.request?.displayVersion, 1);
    assert.deepEqual(shiftedDetail.versions.map((version) => version.version), [1]);
    assert.deepEqual(shiftedDetail.versions.map((version) => version.displayVersion), [1]);
    const shiftedVersion = await ui<{ request?: { request?: { version?: number; displayVersion?: number } } }>(`/api/ui/requests/${shifted.id}/versions/1`);
    assert.equal(shiftedVersion.request?.request?.version, 1);
    assert.equal(shiftedVersion.request?.request?.displayVersion, 1);
    const shiftedActive = await ui<{ requests: Array<{ id?: string; version?: number; displayVersion?: number }> }>(
      `/api/ui/requests?scope=active&createdRange=1h&q=version-one-after-empty-v0`,
    );
    assert.deepEqual(shiftedActive.requests.map((request) => ({ id: request.id, version: request.version, displayVersion: request.displayVersion })), [
      { id: shifted.id, version: 1, displayVersion: 1 },
    ]);

    const active = await ui<{ requests: Array<{ id?: string }> }>(`/api/ui/requests?scope=active&createdRange=1h&q=needle-full-text-content`);
    assert.deepEqual(active.requests.map((request) => request.id), [created.id]);

    await ui(`/api/ui/requests/${created.id}/archive`, { method: "POST" });
    const archived = await ui<{ requests: Array<{ id?: string; archived?: boolean }> }>(`/api/ui/requests?scope=archived&createdRange=1h&q=needle-full-text-content`);
    assert.deepEqual(archived.requests.map((request) => request.id), [created.id]);
    assert.equal(archived.requests[0]?.archived, true);

    await ui(`/api/ui/requests/${created.id}/restore`, { method: "POST" });
    const restored = await ui<{ requests: Array<{ id?: string; archived?: boolean }> }>(`/api/ui/requests?scope=active&createdRange=1h&q=needle-full-text-content`);
    assert.deepEqual(restored.requests.map((request) => request.id), [created.id]);
    assert.equal(restored.requests[0]?.archived, false);

    const stats = await ui<{
      totals?: { requestCount?: number; versionCount?: number; requestBytes?: number; sentBytes?: number; receivedBytes?: number };
      versions?: Array<{ version?: number; displayVersion?: number }>;
      byDay?: unknown[];
      byMonth?: unknown[];
    }>(`/api/ui/stats?scope=all&createdRange=1h`);
    assert.equal(stats.totals?.requestCount, 3);
    assert.equal(stats.totals?.versionCount, 2);
    assert.ok((stats.totals?.requestBytes ?? 0) > 0);
    assert.equal(stats.totals?.sentBytes, 0);
    assert.equal(stats.totals?.receivedBytes, 0);
    assert.ok(stats.versions?.some((version) => version.version === 0 && version.displayVersion === 1));
    assert.ok(stats.versions?.some((version) => version.version === 1 && version.displayVersion === 1));
    assert.ok((stats.byDay?.length ?? 0) >= 1);
    assert.ok((stats.byMonth?.length ?? 0) >= 1);

    const shell = await fetch(`${endpoint}/`);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /DeepSeek MCP Requests/);
    const statsShell = await fetch(`${endpoint}/stats`);
    assert.equal(statsShell.status, 200);
    assert.match(await statsShell.text(), /DeepSeek MCP Requests/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (oldDataDir === undefined) delete process.env.DEEPSEEK_DATA_DIR;
    else process.env.DEEPSEEK_DATA_DIR = oldDataDir;
  }
});
