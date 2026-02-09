# IssueCommand

IssueCommand is a Bun application that coordinates GitHub issue claims across multiple coding agents.
It runs two transports in one process:

- MCP stdio server for local agent tooling.
- HTTP JSON + SSE server for remote agents.

## Features

- Claim exclusivity with per-issue locking.
- Idempotent re-claim for the current owner.
- Stale detection and optional auto-release.
- PR follow-up queue from GitHub webhook events (`changes_requested`, PR comments, review comments).
- GitHub sync for external closures and metadata updates.
- Crash recovery through durable SQLite persistence (relational row-level writes).
- Real-time claim/sync events via SSE.

## Requirements

- Bun 1.3+
- GitHub PAT with scopes:
  - `repo`
  - `read:org`
  - `read:issue`
  - `write:issue`
- GitHub CLI (`gh`) is optional; IssueCommand uses it when available and falls back to REST API automatically.

## Setup

1. Install dependencies:

```bash
bun install
```

2. Create env config:

```bash
cp .env.example .env
```

3. Update `.env` values.

4. Start IssueCommand:

```bash
bun run start
```

`HTTP_PORT` defaults to `3100`.

State is persisted in a local SQLite DB file (`SQLITE_PATH`) and survives restarts/redeployments.

## Configuration

| Variable | Required | Default | Description |
|---|---:|---|---|
| `GITHUB_TOKEN` | yes | - | GitHub PAT used for API/CLI auth |
| `API_KEY` | yes | - | Required bearer token for all HTTP endpoints and SSE |
| `HTTP_PORT` | no | `3100` | HTTP/SSE port |
| `TRUST_PROXY` | no | `false` | Trust `x-forwarded-for` / `x-real-ip` for client IP derivation (set `true` only behind a trusted proxy) |
| `SQLITE_PATH` | no | `./issuecommand.db` | SQLite database file path for durable local persistence |
| `SQLITE_BUSY_TIMEOUT_MS` | no | `5000` | SQLite busy timeout for concurrent access retries |
| `SQLITE_JOURNAL_MODE` | no | `WAL` | SQLite journal mode (recommended: `WAL`) |
| `WEBHOOK_DEDUPE_MAX_ENTRIES` | no | `20000` | Max persisted GitHub webhook delivery IDs retained for duplicate protection |
| `WEBHOOK_ENABLED` | no | `true` | Enable GitHub webhook ingestion endpoint |
| `WEBHOOK_PATH` | no | `/api/webhooks/github` | Path used for GitHub webhook ingestion |
| `GITHUB_WEBHOOK_SECRET` | no | `""` | HMAC secret for GitHub webhook signatures (`X-Hub-Signature-256`) |
| `CLAIM_TIMEOUT_MINUTES` | no | `120` | Minutes since last update before claim is marked stale |
| `STALE_AUTO_RELEASE_MINUTES` | no | `0` | Minutes after stale before auto-release (`0` disables) |
| `AUTO_CLOSE_GITHUB_ISSUE` | no | `false` | If `true`, close GitHub issue when claim status becomes `closed` |
| `HISTORY_MAX_ENTRIES` | no | `1000` | Maximum number of completed/released claims retained in memory/state |
| `FOLLOWUP_STALE_MINUTES` | no | `1440` | Minutes since last update before an active follow-up is marked stale |
| `FOLLOWUP_MAX_ENTRIES` | no | `2000` | Maximum number of completed/dismissed follow-ups retained in memory/state |
| `SYNC_INTERVAL_MINUTES` | no | `15` | GitHub reconciliation interval |
| `ALLOWED_REPOS` | no | `""` | Comma-separated `owner/repo` whitelist |
| `LOG_FILE` | no | `""` | Optional JSON log output file |
| `RATE_LIMIT_ENABLED` | no | `true` | Enable in-memory HTTP throttling |
| `RATE_LIMIT_IP_PER_MINUTE` | no | `120` | Per-IP request refill rate for `/api/*` |
| `RATE_LIMIT_IP_BURST` | no | `40` | Per-IP burst capacity for `/api/*` |
| `RATE_LIMIT_AGENT_MUTATIONS_PER_MINUTE` | no | `40` | Mutation refill rate applied to both authenticated principal and `agent_id` |
| `RATE_LIMIT_AGENT_MUTATIONS_BURST` | no | `20` | Mutation burst capacity applied to both authenticated principal and `agent_id` |
| `RATE_LIMIT_SSE_CONNECT_PER_MINUTE` | no | `10` | Per-IP SSE connection-attempt refill rate |
| `RATE_LIMIT_SSE_CONNECT_BURST` | no | `10` | Per-IP SSE connection-attempt burst |

## MCP Tools

- `list_repos`
- `list_open_issues`
- `get_issue_details`
- `next_issue`
- `next_work`
- `claim_issue`
- `release_issue`
- `update_claim_status`
- `get_followups`
- `update_followup_status`
- `get_my_claims`
- `get_my_work`
- `get_all_claims`
- `get_claim_history`
- `system_health`

### Claim Mutation Tool Inputs

- `release_issue` requires `claim_id` and `agent_id` (`reason` optional).
- `update_claim_status` requires `claim_id`, `agent_id`, and `status` (`note`/`pr_url` optional).

## HTTP API

All HTTP endpoints except webhook ingestion require:

```http
Authorization: Bearer <API_KEY>
```

Webhook ingestion (`WEBHOOK_PATH`, default `/api/webhooks/github`) accepts either:

- `Authorization: Bearer <API_KEY>`
- GitHub `X-Hub-Signature-256` validated with `GITHUB_WEBHOOK_SECRET`

### Endpoints

- `GET /sse`
- `GET /api/repos`
- `GET /api/repos/:owner/:repo/issues`
- `GET /api/issues/:owner/:repo/:number`
- `POST /api/next`
- `POST /api/next-work`
- `POST /api/claims`
- `DELETE /api/claims/:claim_id`
- `PATCH /api/claims/:claim_id`
- `GET /api/followups`
- `PATCH /api/followups/:work_item_id`
- `GET /api/my-work`
- `POST /api/webhooks/github` (or configured `WEBHOOK_PATH`, auth via API key or GitHub signature)
- `GET /api/claims`
- `GET /api/health`

### Example HTTP calls

Get repos:

```bash
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:3100/api/repos
```

Claim issue:

```bash
curl -X POST http://localhost:3100/api/claims \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"claude-code-macmini-1","repo":"myorg/api","issue_number":42}'
```

Claim next issue in one call:

```bash
curl -X POST http://localhost:3100/api/next \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"claude-code-macmini-1","repo":"myorg/api"}'
```

Claim next work item (PR follow-up first, issue fallback):

```bash
curl -X POST http://localhost:3100/api/next-work \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"claude-code-macmini-1","repo":"myorg/api"}'
```

Update status:

```bash
curl -X PATCH http://localhost:3100/api/claims/<claim_id> \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"claude-code-macmini-1","status":"in_progress"}'
```

Release claim:

```bash
curl -X DELETE http://localhost:3100/api/claims/<claim_id> \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"claude-code-macmini-1","reason":"handing off"}'
```

Subscribe to events:

```bash
curl -N -H "Authorization: Bearer $API_KEY" http://localhost:3100/sse
```

Send a signed GitHub webhook (example):

```bash
BODY='{"action":"submitted","repository":{"full_name":"myorg/api"}}'
SIG="sha256=$(printf "%s" "$BODY" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" -hex | sed 's/^.* //')"

curl -X POST http://localhost:3100/api/webhooks/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request_review" \
  -H "X-GitHub-Delivery: demo-delivery-id" \
  -H "X-Hub-Signature-256: $SIG" \
  -d "$BODY"
```

## Example Agent Workflow

1. Agent requests next work:

```json
{"agent_id":"claude-code-1","repo":"myorg/api"}
```

2. IssueCommand returns either:
   - PR follow-up work item (`kind: "pr_followup"`) when review feedback is queued, or
   - issue claim + issue details (`kind: "issue"`) when no follow-up is queued.
3. For issue work, agent updates claim status through `in_progress` -> `pr_submitted` -> `pr_merged` -> `closed`.
4. For follow-up work, agent updates follow-up status (typically `in_progress` then `done`).
5. GitHub webhook events can enqueue new follow-up work or auto-resolve stale follow-ups on PR `synchronize`.

## Deployment

### Docker Compose (recommended)

IssueCommand includes a hardened container profile with:

- `restart: unless-stopped`
- read-only root filesystem
- dropped Linux capabilities
- `no-new-privileges`
- authenticated healthcheck against `/api/health`
- persistent claim state volume (`issuecommand_data`)

Run:

```bash
bun run docker:up
```

Stop:

```bash
bun run docker:down
```

The container persists state at `/app/data/issuecommand.db` via the named volume.

### Host Process Manager (PM2)

`ecosystem.config.cjs` is included for host deployments without containers.

Important: run one instance only (`instances: 1`) because v1 uses in-memory locks/state authority.

Start:

```bash
export $(grep -v '^#' .env | xargs)
bun run pm2:start
```

Restart with updated env:

```bash
bun run pm2:restart
```

Stop:

```bash
bun run pm2:stop
```

## Claude Desktop MCP Config Example

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "issuecommand": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/issuecommand/src/index.ts"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token",
        "API_KEY": "shared-secret",
        "HTTP_PORT": "3100",
        "TRUST_PROXY": "false",
        "SQLITE_PATH": "/absolute/path/to/issuecommand/issuecommand.db",
        "SQLITE_BUSY_TIMEOUT_MS": "5000",
        "SQLITE_JOURNAL_MODE": "WAL",
        "WEBHOOK_DEDUPE_MAX_ENTRIES": "20000",
        "WEBHOOK_ENABLED": "true",
        "WEBHOOK_PATH": "/api/webhooks/github",
        "GITHUB_WEBHOOK_SECRET": "",
        "CLAIM_TIMEOUT_MINUTES": "120",
        "STALE_AUTO_RELEASE_MINUTES": "0",
        "HISTORY_MAX_ENTRIES": "1000",
        "FOLLOWUP_STALE_MINUTES": "1440",
        "FOLLOWUP_MAX_ENTRIES": "2000",
        "SYNC_INTERVAL_MINUTES": "15",
        "ALLOWED_REPOS": "",
        "LOG_FILE": "",
        "AUTO_CLOSE_GITHUB_ISSUE": "false",
        "RATE_LIMIT_ENABLED": "true",
        "RATE_LIMIT_IP_PER_MINUTE": "120",
        "RATE_LIMIT_IP_BURST": "40",
        "RATE_LIMIT_AGENT_MUTATIONS_PER_MINUTE": "40",
        "RATE_LIMIT_AGENT_MUTATIONS_BURST": "20",
        "RATE_LIMIT_SSE_CONNECT_PER_MINUTE": "10",
        "RATE_LIMIT_SSE_CONNECT_BURST": "10"
      }
    }
  }
}
```

## Testing

```bash
bun run typecheck
bun test
```

## Notes

- Logs are emitted on stderr to avoid interfering with MCP stdio protocol output.
- By default, state is persisted to SQLite (`SQLITE_PATH`) and loaded on startup.
- SQLite persistence uses relational tables with incremental row updates (active claims/followups, history, and runtime metadata), not full-state blob rewrites.
- Completed claim history is bounded by `HISTORY_MAX_ENTRIES`; oldest records are trimmed first.
- Follow-up history is bounded by `FOLLOWUP_MAX_ENTRIES`; oldest records are trimmed first.
- Webhook delivery dedupe keys are also persisted in SQLite for duplicate protection across restarts.
- Startup logs include `gh` CLI availability (`github.gh.available` or `github.gh.unavailable`).
- HTTP rate limiting returns `429` with a `Retry-After` header and JSON body `{ error: \"rate_limited\", scope, retry_after_seconds }`.
- Mutation routes enforce rate limits by both authenticated principal and provided `agent_id`.
- `TRUST_PROXY=false` is the safe default; enable it only when a trusted reverse proxy sanitizes forwarding headers.
- Webhook ingestion accepts either `Authorization: Bearer <API_KEY>` or GitHub `X-Hub-Signature-256` when `GITHUB_WEBHOOK_SECRET` is set.
