# dsh-agent-gateway

A generic, multi-session HTTP/SSE gateway plugin for [deepseek-harness](https://github.com/deepseek-ai) (dsh) agents.

It turns one dsh process into a service: many named users, many agent presets, isolated sessions, streaming output over SSE, and pluggable tool / deliverable policies — all driven by configuration, with no business logic baked in.

## Features

- **Explicit sessions** — clients create, list, resume and delete sessions; each session is scoped to a `principal + agent` pair.
- **Multi-tenant isolation** — deterministic identity routing with per-identity ownership verification.
- **HTTP API** — RESTful endpoints under a configurable base path.
- **SSE event stream** — token-level streaming with resumable connections via `?lastSeq=N`.
- **Service-to-service auth** — Bearer token authentication, plus optional per-session end-user token passthrough via a request header.
- **Concurrency control** — global turn pool plus optional per-session serialization.
- **Configurable convergence** — tool allow-list, deliverable ("file") tools and `document_type` injection are all config-driven; empty by default.
- **Minimal error disclosure** — internal details are never leaked to clients.

## Requirements

- Node.js >= 22
- A dsh host that provides the `agents`, `webServer`, `agentPresets`, `sessionPersistence` and `agentDefaultModel` services

## Installation

This package is a dsh bundle plugin. From your dsh profile:

```bash
dsh plugin --profile <profile> add dsh-agent-gateway
```

The plugin does not auto-load. `cordis.patch.yml` intentionally contributes an empty patch so each profile chooses whether to enable it.

## Quick start

```bash
# 1. Create a session
SESSION_ID=$(curl -s -X POST http://localhost:8080/v1/users/alice/agents/assistant/sessions \
  -H "Authorization: Bearer your-service-token" \
  -H "Content-Type: application/json" \
  -d '{}' | jq -r .sessionId)

# 2. Start a turn
curl -X POST http://localhost:8080/v1/users/alice/agents/assistant/sessions/$SESSION_ID/turns \
  -H "Authorization: Bearer your-service-token" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!", "mode": "queue"}'

# 3. Stream the output
curl -N http://localhost:8080/v1/users/alice/agents/assistant/sessions/$SESSION_ID/events \
  -H "Authorization: Bearer your-service-token"

# 4. Delete the session
curl -X DELETE http://localhost:8080/v1/users/alice/agents/assistant/sessions/$SESSION_ID \
  -H "Authorization: Bearer your-service-token"
```

## API routes

`{basePath}` defaults to `/v1` (see `http.basePath`).

### Probes and capabilities

- `GET /healthz` — liveness
- `GET /readyz` — readiness (own-process counters only)
- `GET {basePath}/capabilities` — list of available agents

### Session management

- `POST {basePath}/users/:u/agents/:agent/sessions` — create session
- `GET {basePath}/users/:u/agents/:agent/sessions` — list sessions
- `DELETE {basePath}/users/:u/agents/:agent/sessions/:sessionId` — delete session

### Conversation

- `POST {basePath}/users/:u/agents/:agent/sessions/:sessionId/turns` — create a turn (`queue` / `steer` modes)
- `DELETE {basePath}/users/:u/agents/:agent/sessions/:sessionId/turns` — cancel the current turn
- `GET {basePath}/users/:u/agents/:agent/sessions/:sessionId/events` — SSE event stream
- `GET {basePath}/users/:u/agents/:agent/sessions/:sessionId/history` — session history

## Configuration

```yaml
dsh-agent-gateway:
  auth:
    serviceToken: 'your-service-token'   # service-to-service token
    userTokenHeader: 'x-user-token'      # per-session end-user token header (case-insensitive; matching Cookie also accepted)
  http:
    basePath: '/v1'                      # public API route prefix
  concurrency:
    maxGlobalTurns: 10                   # global concurrent turn limit
    serialPerSession: true               # serialize turns within a session
  sse:
    maxConnections: 100                  # global SSE connection limit
    maxConnectionsPerUser: 5             # per-user SSE connection limit
    maxQueueSize: 1048576                # per-connection send buffer limit (bytes)
  request:
    maxBodySize: 1048576                 # request body limit (bytes)
  sessions:
    maxPerIdentity: 20                   # max sessions per principal + agent pair
  tools:
    allowedTools: []                     # tool allow-list; empty = no convergence
  deliveries:
    fileTools: []                        # tool names whose results are persisted as session deliverables; empty = disabled
  writing:
    agents: []                           # agent IDs allowed to receive document_type; empty = unrestricted
    documentTypes: []                    # allowed document_type values; empty = disabled
  agentPresets:
    assistant: 'agent.assistant'         # agent ID -> preset name
  audit:
    enabled: true
  observability:
    consoleExporter: true
    level: 3
    colors: true
```

### Notes on the end-user token

When `auth.userTokenHeader` is set, the plugin reads that header (or a same-named Cookie) on a request, and — only after session ownership verification passes — stashes it per session for tool plugins to read. The token is kept in memory only and never appears in logs, responses or audit records.

## License

Apache-2.0