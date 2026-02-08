# IssueCommand

IssueCommand is a Bun application that coordinates GitHub issue claims across multiple coding agents.
It runs two transports in one process:

- MCP stdio server for local agent tooling.
- HTTP JSON + SSE server for remote agents.

## Features

- Claim exclusivity with per-issue locking.
- Idempotent re-claim for the current owner.
- Stale detection and optional auto-release.
- GitHub sync for external closures and metadata updates.
- Crash recovery through debounced JSON state persistence.
- Real-time claim/sync events via SSE.

## Requirements

- Bun 1.3+
- GitHub PAT with scopes:
  - `repo`
  - `read:org`
  - `read:issue`
  - `write:issue`
- GitHub CLI (`gh`) available on PATH (IssueCommand uses `gh` where practical and falls back to REST API).

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

## Configuration

| Variable | Required | Default | Description |
|---|---:|---|---|
| `GITHUB_TOKEN` | yes | - | GitHub PAT used for API/CLI auth |
| `API_KEY` | yes | - | Required bearer token for all HTTP endpoints and SSE |
| `HTTP_PORT` | no | `3100` | HTTP/SSE port |
| `CLAIM_TIMEOUT_MINUTES` | no | `120` | Minutes since last update before claim is marked stale |
| `STALE_AUTO_RELEASE_MINUTES` | no | `0` | Minutes after stale before auto-release (`0` disables) |
| `AUTO_CLOSE_GITHUB_ISSUE` | no | `false` | If `true`, close GitHub issue when claim status becomes `closed` |
| `STATE_FILE_PATH` | no | `./issuecommand-state.json` | Persisted claim state file |
| `SYNC_INTERVAL_MINUTES` | no | `15` | GitHub reconciliation interval |
| `ALLOWED_REPOS` | no | `""` | Comma-separated `owner/repo` whitelist |
| `LOG_FILE` | no | `""` | Optional JSON log output file |

## MCP Tools

- `list_repos`
- `list_open_issues`
- `get_issue_details`
- `next_issue`
- `claim_issue`
- `release_issue`
- `update_claim_status`
- `get_my_claims`
- `get_all_claims`
- `get_claim_history`
- `system_health`

## HTTP API

All endpoints require:

```http
Authorization: Bearer <API_KEY>
```

### Endpoints

- `GET /sse`
- `GET /api/repos`
- `GET /api/repos/:owner/:repo/issues`
- `GET /api/issues/:owner/:repo/:number`
- `POST /api/claims`
- `DELETE /api/claims/:claim_id`
- `PATCH /api/claims/:claim_id`
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

Update status:

```bash
curl -X PATCH http://localhost:3100/api/claims/<claim_id> \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status":"in_progress"}'
```

Subscribe to events:

```bash
curl -N -H "Authorization: Bearer $API_KEY" http://localhost:3100/sse
```

## Example Agent Workflow

1. Agent requests next issue:

```json
{"agent_id":"claude-code-1","repo":"myorg/api"}
```

2. IssueCommand returns claim + issue details.
3. Agent updates status to `in_progress`.
4. Agent updates status to `pr_submitted` with `pr_url`.
5. Agent updates status to `pr_merged`.
6. Agent updates status to `closed`.

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

The container persists state at `/app/data/issuecommand-state.json` via the named volume.

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
        "CLAIM_TIMEOUT_MINUTES": "120",
        "STALE_AUTO_RELEASE_MINUTES": "0",
        "STATE_FILE_PATH": "/absolute/path/to/issuecommand/issuecommand-state.json",
        "SYNC_INTERVAL_MINUTES": "15",
        "ALLOWED_REPOS": "",
        "LOG_FILE": "",
        "AUTO_CLOSE_GITHUB_ISSUE": "false"
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
- State is persisted on claim mutations with debounced writes and loaded on startup.
