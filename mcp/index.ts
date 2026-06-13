#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startMcpHttpServer } from "./http/mcpHttp.js";
import { createDeepSeekMcpServer } from "./server.js";

startMcpHttpServer();

const server = createDeepSeekMcpServer();
const transport = new StdioServerTransport();

server.connect(transport).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`deepseek-v4-mcp fatal error: ${message}`);
  process.exitCode = 1;
});
