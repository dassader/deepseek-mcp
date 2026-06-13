import os from "node:os";

export interface McpHttpConfig {
  enabled: boolean;
  host: string;
  port: number;
  path: string;
  publicBaseUrl?: string;
}

export interface McpHttpDescription {
  enabled: boolean;
  listening: boolean;
  host: string;
  port: number;
  path: string;
  baseUrls: string[];
  endpointUrls: string[];
  transport: string;
  sessionMode: string;
  endpoints: string[];
  security: string[];
  setup: string[];
}

function boolFromEnv(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }
  return ["1", "true", "yes", "on", "enabled"].includes(value.toLowerCase());
}

function numberFromEnv(name: string, value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function normalizedPath(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    return "/mcp";
  }
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.replace(/\/+$/u, "") || "/mcp";
}

function displayHostUrls(config: McpHttpConfig): string[] {
  if (config.publicBaseUrl) {
    return [config.publicBaseUrl.replace(/\/+$/u, "")];
  }
  if (config.host !== "0.0.0.0" && config.host !== "::") {
    return [`http://${config.host}:${config.port}`];
  }

  const urls = new Set<string>([`http://127.0.0.1:${config.port}`]);
  for (const values of Object.values(os.networkInterfaces())) {
    for (const item of values ?? []) {
      if (item.family === "IPv4" && !item.internal) {
        urls.add(`http://${item.address}:${config.port}`);
      }
    }
  }
  return [...urls];
}

export function mcpHttpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): McpHttpConfig {
  const publicBaseUrl = env.DEEPSEEK_MCP_HTTP_PUBLIC_BASE_URL && env.DEEPSEEK_MCP_HTTP_PUBLIC_BASE_URL.trim().length > 0 ? env.DEEPSEEK_MCP_HTTP_PUBLIC_BASE_URL : undefined;
  return {
    enabled: boolFromEnv(env.DEEPSEEK_MCP_HTTP_ENABLED, false),
    host: env.DEEPSEEK_MCP_HTTP_HOST ?? "127.0.0.1",
    port: numberFromEnv("DEEPSEEK_MCP_HTTP_PORT", env.DEEPSEEK_MCP_HTTP_PORT, 8788),
    path: normalizedPath(env.DEEPSEEK_MCP_HTTP_PATH),
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
  };
}

export function describeMcpHttp(config: McpHttpConfig = mcpHttpConfigFromEnv(), listening = false): McpHttpDescription {
  const baseUrls = displayHostUrls(config);
  const endpointUrls = baseUrls.map((url) => `${url}${config.path}`);
  return {
    enabled: config.enabled,
    listening,
    host: config.host,
    port: config.port,
    path: config.path,
    baseUrls,
    endpointUrls,
    transport: "MCP Streamable HTTP",
    sessionMode: "stateless per HTTP request",
    endpoints: [
      `GET /health`,
      `POST ${config.path} for JSON-RPC MCP requests`,
      `OPTIONS ${config.path} for CORS preflight`,
    ],
    security: [
      "This endpoint exposes the same MCP tools as stdio over HTTP. Any client that can reach it can ask this process to validate, archive, and send DeepSeek requests.",
      config.host === "127.0.0.1" || config.host === "::1"
        ? "Current bind host is loopback-only. LAN agents cannot reach it until DEEPSEEK_MCP_HTTP_HOST is set to 0.0.0.0 or a LAN IP."
        : "Current bind host is reachable beyond loopback. Use only on a trusted network because DeepSeek spend is controlled by this process environment.",
      "Client agents do not need DEEPSEEK_API_KEY. This process reads the key from its own environment when a send request is executed.",
    ],
    setup: [
      "Enable with DEEPSEEK_MCP_HTTP_ENABLED=true.",
      "For local tests, send JSON-RPC to the endpoint URL with Content-Type: application/json and Accept: application/json, text/event-stream.",
      "For home LAN access, set DEEPSEEK_MCP_HTTP_HOST=0.0.0.0 and optionally DEEPSEEK_MCP_HTTP_PUBLIC_BASE_URL=http://YOUR_LAN_IP:8788.",
    ],
  };
}
