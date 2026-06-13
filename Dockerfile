FROM node:22-alpine AS build

WORKDIR /app

COPY .npmrc package.json package-lock.json ./
RUN npm ci && \
  rollup_version="$(node -p "require('./node_modules/rollup/package.json').version")" && \
  node_arch="$(node -p "process.arch")" && \
  case "$node_arch" in \
    arm64|x64) npm install --no-save --ignore-scripts "@rollup/rollup-linux-${node_arch}-musl@${rollup_version}" ;; \
    *) echo "Unsupported container architecture for Rollup: ${node_arch}" >&2; exit 1 ;; \
  esac

COPY assets ./assets
COPY mcp ./mcp
COPY test ./test
COPY tsconfig.json ./
COPY ui ./ui

RUN npm run build

FROM alpine:3.22 AS runtime

ARG OCI_SOURCE="https://github.com/local/deepseek-mcp"

LABEL org.opencontainers.image.title="DeepSeek MCP"
LABEL org.opencontainers.image.description="DeepSeek V4 MCP server with browser UI"
LABEL org.opencontainers.image.source=$OCI_SOURCE

ENV NODE_ENV=production
ENV DEEPSEEK_MCP_HTTP_ENABLED=true
ENV DEEPSEEK_MCP_HTTP_HOST=0.0.0.0
ENV DEEPSEEK_MCP_HTTP_PORT=8799
ENV DEEPSEEK_DATA_DIR=/app/data

WORKDIR /app

RUN apk add --no-cache ca-certificates libstdc++ && \
  addgroup -S deepseek && \
  adduser -S deepseek -G deepseek && \
  mkdir -p /app/data && \
  chown -R deepseek:deepseek /app

COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build --chown=deepseek:deepseek /app/package.json ./
COPY --from=build --chown=deepseek:deepseek /app/assets ./assets
COPY --from=build --chown=deepseek:deepseek /app/dist/runtime ./dist/runtime
COPY --from=build --chown=deepseek:deepseek /app/dist/ui ./dist/ui

USER deepseek

EXPOSE 8799
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.DEEPSEEK_MCP_HTTP_PORT || '8799') + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/runtime/index.js"]
