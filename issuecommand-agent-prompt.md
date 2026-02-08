# Build: IssueCommand — MCP + HTTP Server (Bun)

## Overview

Build **IssueCommand**, a Bun application that serves as a **centralized issue claim/ticketing system** for multiple coding agents working across shared GitHub repositories. IssueCommand coordinates which agent is working on which issue, preventing duplicate work and eliminating the need for each agent to spend context searching for and selecting issues.

## Core Problem

When multiple coding agents work on the same repos, they waste context and risk conflicts by independently browsing issues. IssueCommand acts as a **single source of truth** — agents request the next available issue, the system assigns it, and tracks the full lifecycle from claim → PR → merge → close.

---

## Architecture

### Dual-Transport Server

The app must expose **both** transport modes simultaneously:

1. **Local MCP Server** (stdio) — for agents running on the same machine
2. **HTTP SSE Streaming Server** — for agents on remote machines across a network

Both transports share the same underlying state and logic.

### Authentication

- Use a **GitHub Personal Access Token (PAT)** for all GitHub API access
- The PAT must have scopes for: `repo`, `read:org`, `read:issue`, `write:issue`
- Support access to:
  - All repositories owned by the authenticated user
  - All repositories in organizations where the user is an owner/member

### Tech Stack

- **Runtime:** Bun
- **MCP SDK:** `@modelcontextprotocol/sdk` (use the official MCP TypeScript SDK)
- **GitHub Access:** GitHub CLI (`gh`) commands OR GitHub REST/GraphQL API (prefer `gh` CLI where practical, fall back to API for complex queries)
- **State:** In-memory with periodic JSON file persistence for crash recovery
- **HTTP:** Bun's built-in HTTP server for the SSE transport

---

## MCP Tools to Expose

### Issue Discovery

| Tool | Description |
|------|-------------|
| `list_repos` | List all accessible repos (personal + org) with open issue counts |
| `list_open_issues` | List **unclaimed** open issues for a given repo (filters OUT already-claimed issues). Supports optional label/milestone filters. |
| `get_issue_details` | Full issue detail including body, comments, labels, assignees, and status |
| `next_issue` | **Convenience tool** — returns the highest-priority unclaimed issue from a specified repo (or across all repos) and immediately claims it for the requesting agent. Combines discovery + claim in one call to minimize agent context usage. |

### Claim Lifecycle

| Tool | Description |
|------|-------------|
| `claim_issue` | Agent claims an issue by providing: `agent_id`, `repo`, `issue_number`. Returns claim confirmation or rejection (if already claimed). |
| `release_issue` | Agent releases a claim (abandoned work, blocked, error, etc.) |
| `update_claim_status` | Agent reports progress. Valid status transitions: `claimed` → `in_progress` → `pr_submitted` → `pr_merged` → `closed` |
| `get_my_claims` | Agent retrieves all its active claims by `agent_id` |

### System Status

| Tool | Description |
|------|-------------|
| `get_all_claims` | View all active claims across all repos/agents |
| `get_claim_history` | Historical log of completed/abandoned claims with timestamps |
| `system_health` | Returns server uptime, total claims, active agents, last GitHub sync time |

---

## HTTP SSE API Endpoints

For remote agents that cannot use stdio MCP, expose equivalent functionality over HTTP:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/sse` | SSE stream for real-time claim events (new claims, releases, status changes) |
| `GET` | `/api/repos` | List repos |
| `GET` | `/api/repos/:owner/:repo/issues` | List unclaimed open issues |
| `GET` | `/api/issues/:owner/:repo/:number` | Get issue details |
| `POST` | `/api/claims` | Claim an issue (`{ agent_id, repo, issue_number }`) |
| `DELETE` | `/api/claims/:claim_id` | Release a claim |
| `PATCH` | `/api/claims/:claim_id` | Update claim status |
| `GET` | `/api/claims` | List all active claims (filterable by `?agent_id=`) |
| `GET` | `/api/health` | System health check |

All endpoints return JSON. Authentication via `Authorization: Bearer <token>` header or configurable API key.

---

## Key Behaviors

1. **Claim Exclusivity:** Once an issue is claimed, it MUST NOT appear in `list_open_issues` or `next_issue` results for other agents. Use a mutex/lock to prevent race conditions when two agents claim simultaneously.

2. **Race Condition Handling:** Use an in-memory lock (e.g., a claim-in-progress Set) so that concurrent `claim_issue` calls for the same issue are serialized. Only the first succeeds; the second gets a rejection response (not an error).

3. **Stale Claim Detection:** If an agent hasn't called `update_claim_status` within a configurable timeout (default: 2 hours), flag the claim as `stale`. Stale claims can be listed separately and optionally auto-released after a second timeout.

4. **GitHub Sync:** Periodically sync issue status from GitHub to:
   - Catch issues closed externally (outside this system)
   - Detect new issues opened since last sync
   - Update labels/assignees that changed on GitHub

5. **Idempotent Claims:** If an agent tries to claim an issue it already owns, return success (not an error). If a different agent tries to claim it, return a clear rejection with the current owner's `agent_id`.

6. **Crash Recovery:** Persist full claim state to a JSON file on every state change (debounced to avoid excessive writes). On startup, reload state from this file.

7. **Agent Identity:** Agents self-identify with a string `agent_id` (e.g., `"claude-code-macmini-1"`, `"cursor-workstation-2"`). No registration required — agents are recognized on first claim.

8. **Logging:** Log all claim events (claim, release, status change, stale detection) with timestamps to stdout and optionally to a log file for debugging multi-agent coordination.

---

## Data Models

### Claim Record

```typescript
interface ClaimRecord {
  claim_id: string;           // UUID
  agent_id: string;           // Self-reported agent identifier
  repo: string;               // "owner/repo" format
  issue_number: number;
  issue_title: string;
  status: ClaimStatus;
  claimed_at: string;         // ISO 8601
  last_updated: string;       // ISO 8601
  status_history: StatusEntry[];
  pr_url?: string;            // Set when status reaches pr_submitted
}

type ClaimStatus = 'claimed' | 'in_progress' | 'pr_submitted' | 'pr_merged' | 'closed' | 'released' | 'stale';

interface StatusEntry {
  status: ClaimStatus;
  timestamp: string;
  note?: string;
}
```

---

## Configuration

Provide a config file or environment variables for:

| Variable | Description | Default |
|----------|-------------|---------|
| `GITHUB_TOKEN` | Personal Access Token | *required* |
| `HTTP_PORT` | Port for SSE streaming server | `3100` |
| `CLAIM_TIMEOUT_MINUTES` | Minutes before a claim is flagged stale | `120` |
| `STALE_AUTO_RELEASE_MINUTES` | Minutes after stale flag before auto-release (0 = disabled) | `0` |
| `STATE_FILE_PATH` | Path for persisted claim state | `./issuecommand-state.json` |
| `SYNC_INTERVAL_MINUTES` | GitHub issue sync frequency | `15` |
| `ALLOWED_REPOS` | Comma-separated whitelist of repos (empty = all accessible) | `""` |
| `LOG_FILE` | Optional log file path (empty = stdout only) | `""` |
| `API_KEY` | Optional API key for HTTP endpoint auth (empty = no auth) | `""` |

---

## Project Structure

```
issuecommand/
├── src/
│   ├── index.ts              # Entry point — starts both MCP and HTTP transports
│   ├── mcp-server.ts         # MCP tool definitions and handlers
│   ├── http-server.ts        # HTTP SSE streaming server + REST endpoints
│   ├── github.ts             # GitHub CLI/API abstraction layer
│   ├── claim-manager.ts      # Core claim state logic, locking, stale detection
│   ├── state-persistence.ts  # JSON file save/load with debounced writes
│   ├── sync.ts               # Periodic GitHub sync logic
│   ├── logger.ts             # Structured logging
│   └── types.ts              # Shared TypeScript types and interfaces
├── config.ts                 # Configuration loading from env/file
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## Deliverables

1. **Fully working IssueCommand Bun application** with both stdio MCP and HTTP SSE transports running simultaneously
2. **README.md** with:
   - Setup instructions
   - GitHub PAT scope requirements
   - Usage examples for both MCP and HTTP modes
   - Example agent workflow (discover → claim → work → update → close)
3. **Example MCP config** snippet for `claude_desktop_config.json`
4. **`.env.example`** with all configuration variables documented

---

## Example Agent Workflow

```
Agent "claude-code-1" connects to IssueCommand:

1. agent → next_issue({ agent_id: "claude-code-1", repo: "myorg/api" })
   ← { claim_id: "abc-123", issue: #42, title: "Fix auth timeout", status: "claimed" }

2. agent → update_claim_status({ claim_id: "abc-123", status: "in_progress" })
   ← { ok: true }

3. [agent works on the code, creates a PR]

4. agent → update_claim_status({ claim_id: "abc-123", status: "pr_submitted", pr_url: "..." })
   ← { ok: true }

5. [PR is reviewed and merged]

6. agent → update_claim_status({ claim_id: "abc-123", status: "closed" })
   ← { ok: true, issue_closed: true }
```
