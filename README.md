# DeepSeek MCP

DeepSeek MCP is a DeepSeek V4 MCP server with a small browser UI for creating, storing, sending, and reviewing requests.

## Run with Docker

```bash
docker run -d \
  --name deepseek-mcp \
  --restart unless-stopped \
  -e DEEPSEEK_API_KEY="replace-with-your-deepseek-api-key" \
  -v deepseek-mcp-data:/app/data \
  -p 8799:8799 \
  ghcr.io/dassader/deepseek-mcp:latest
```

The `/app/data` volume stores requests, responses, reasoning files, archive data, and indexes.

After the container starts:

- MCP endpoint: `http://localhost:8799/mcp`
- User interface: `http://localhost:8799/`
- Health check: `http://localhost:8799/health`

## Run with Compose

Edit `compose.yaml`, replace `DEEPSEEK_API_KEY`, then run:

```bash
docker compose up -d
```

The `latest` image is published as a multi-platform Docker image for `linux/amd64` and `linux/arm64`, so Docker pulls the right variant for the host automatically.
