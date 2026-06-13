import { promises as fs } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createDeepSeekMcpServer } from "../server.js";
import { stringifyPretty } from "../shared/json.js";
import { packageRoot } from "../shared/paths.js";
import { describeMcpHttp, mcpHttpConfigFromEnv, type McpHttpConfig } from "./mcpHttpConfig.js";
import { handleUiApiRequest } from "./uiApi.js";

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  response.setHeader("access-control-allow-headers", "accept, content-type, mcp-protocol-version, mcp-session-id");
  response.setHeader("access-control-expose-headers", "mcp-session-id");
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) {
    return;
  }
  setCorsHeaders(response);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(stringifyPretty(body));
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function serveUiAsset(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const uiDir = path.resolve(packageRoot, "dist", "ui");
  const indexPath = path.join(uiDir, "index.html");
  let relativePath = decodeURIComponent(url.pathname);
  if (relativePath === "/") {
    relativePath = "/index.html";
  }
  const candidate = path.resolve(uiDir, `.${relativePath}`);
  const targetPath = candidate.startsWith(`${uiDir}${path.sep}`) || candidate === uiDir ? candidate : indexPath;
  const staticPath = (await fileExists(targetPath)) ? targetPath : indexPath;
  if (!(await fileExists(staticPath))) {
    return false;
  }

  const body = await fs.readFile(staticPath);
  response.writeHead(200, { "content-type": contentType(staticPath) });
  response.end(body);
  return true;
}

async function handleMcpJsonRpcRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  const server = createDeepSeekMcpServer();

  try {
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(request, response);
  } finally {
    await server.close().catch(() => undefined);
  }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, config: McpHttpConfig): Promise<void> {
  setCorsHeaders(response);
  const path = requestPath(request);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (path === "/health") {
    writeJson(response, 200, {
      ok: true,
      service: "deepseek-v4-mcp-http",
      mcp: describeMcpHttp(config, true),
    });
    return;
  }

  if (await handleUiApiRequest(request, response)) {
    return;
  }

  if (path === config.path) {
    await handleMcpJsonRpcRequest(request, response);
    return;
  }

  if (request.method === "GET" && (await serveUiAsset(request, response))) {
    return;
  }

  if (path !== config.path) {
    writeJson(response, 404, {
      error: {
        message: `Unknown endpoint. Use / for the UI, ${config.path} for MCP JSON-RPC, /api/ui for the UI API, or /health for transport metadata.`,
        type: "deepseek_mcp_http_not_found",
      },
    });
    return;
  }
}

export function startMcpHttpServer(config: McpHttpConfig = mcpHttpConfigFromEnv()): http.Server | undefined {
  if (!config.enabled) {
    return undefined;
  }

  const server = http.createServer((request, response) => {
    handleRequest(request, response, config).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (response.writableEnded) {
        console.error(`deepseek-v4 MCP HTTP request failed after response ended: ${message}`);
        return;
      }
      writeJson(response, 502, {
        error: {
          message,
          type: "deepseek_mcp_http_error",
        },
      });
    });
  });

  server.on("error", (error: Error) => {
    console.error(`deepseek-v4 MCP HTTP failed to listen on ${config.host}:${config.port}: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    const urls = describeMcpHttp(config, true).endpointUrls.join(", ");
    console.error(`deepseek-v4 MCP HTTP listening on ${config.host}:${config.port}${config.path}. MCP endpoint URLs: ${urls}`);
  });
  return server;
}
