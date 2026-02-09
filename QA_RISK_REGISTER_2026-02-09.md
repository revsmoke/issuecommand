# IssueCommand QA Risk Register (Updated)

Date: 2026-02-09  
Reviewer: Codex (GPT-5)  
Scope: `/Users/twoedge/Dev/issuecommand`  
Release gate policy: unresolved `P0`/`P1` findings block release

## 1) Baseline Artifacts

- Commit baseline reviewed: `1089438d8b0af3c631d8fcf32887d2c008413d9c` (working tree includes additional uncommitted remediation changes)
- Branch: `main`
- Bun: `1.3.9`

Commands run:

```bash
bun run typecheck
bun test
bun test --coverage
```

Observed baselines:

- `bun run typecheck`: pass
- `bun test`: `68 pass / 0 fail`
- `bun test --coverage`: `86.17% funcs / 91.39% lines`

## 2) Findings Status

### IC-QA-001
- Severity: `P1`
- Title: Claim mutation authorization ownership enforcement
- Status: `Resolved`
- Evidence:
  - `/Users/twoedge/Dev/issuecommand/src/http-server.ts`
  - `/Users/twoedge/Dev/issuecommand/src/claim-manager.ts`
  - `/Users/twoedge/Dev/issuecommand/src/mcp-server.ts`
  - `/Users/twoedge/Dev/issuecommand/tests/http-server.integration.test.ts`
  - `/Users/twoedge/Dev/issuecommand/tests/mcp-server.integration.test.ts`

### IC-QA-002
- Severity: `P1`
- Title: Sync scheduler overlap/failure handling
- Status: `Resolved`
- Evidence:
  - `/Users/twoedge/Dev/issuecommand/src/sync.ts`
  - `/Users/twoedge/Dev/issuecommand/tests/sync.test.ts`

### IC-QA-003
- Severity: `P2`
- Title: GH issue listing hard-cap behavior
- Status: `Resolved`
- Evidence:
  - `/Users/twoedge/Dev/issuecommand/src/github.ts`
  - `/Users/twoedge/Dev/issuecommand/tests/github.test.ts`

### IC-QA-004
- Severity: `P2`
- Title: REST issue details comment pagination
- Status: `Resolved`
- Evidence:
  - `/Users/twoedge/Dev/issuecommand/src/github.ts`
  - `/Users/twoedge/Dev/issuecommand/tests/github.test.ts`

### IC-QA-005
- Severity: `P2`
- Title: Claim mutation status-code contract precision
- Status: `Resolved`
- Evidence:
  - `/Users/twoedge/Dev/issuecommand/src/http-server.ts`
  - `/Users/twoedge/Dev/issuecommand/tests/http-server.integration.test.ts`

### IC-QA-006
- Severity: `P2`
- Title: Missing CI quality gate
- Status: `Resolved`
- Evidence:
  - `/Users/twoedge/Dev/issuecommand/.github/workflows/ci.yml`

## 3) Additional Post-Review Findings (This Wave)

### IC-QA-007
- Severity: `P1`
- Title: Follow-up dedupe could re-create duplicate work after restart/history trim
- Status: `Resolved`
- Evidence:
  - `/Users/twoedge/Dev/issuecommand/src/followup-manager.ts`
  - `/Users/twoedge/Dev/issuecommand/tests/followup-manager.test.ts`

### IC-QA-008
- Severity: `P1`
- Title: Shutdown could lose writes when sync/follow-up sweep was still in flight
- Status: `Resolved`
- Evidence:
  - `/Users/twoedge/Dev/issuecommand/src/sync.ts`
  - `/Users/twoedge/Dev/issuecommand/src/followup-sweep-scheduler.ts`
  - `/Users/twoedge/Dev/issuecommand/src/index.ts`
  - `/Users/twoedge/Dev/issuecommand/tests/sync.test.ts`
  - `/Users/twoedge/Dev/issuecommand/tests/followup-sweep-scheduler.test.ts`

### IC-QA-009
- Severity: `P2`
- Title: HTTP unexpected failures were reported as 400 and leaked internal error detail
- Status: `Resolved`
- Evidence:
  - `/Users/twoedge/Dev/issuecommand/src/http-server.ts`
  - `/Users/twoedge/Dev/issuecommand/tests/http-server.integration.test.ts`

### IC-QA-010
- Severity: `P2`
- Title: Mutation throttling bypass by rotating `agent_id`
- Status: `Resolved`
- Evidence:
  - `/Users/twoedge/Dev/issuecommand/src/http-server.ts`
  - `/Users/twoedge/Dev/issuecommand/tests/http-server.integration.test.ts`

### IC-QA-011
- Severity: `P2`
- Title: JSON state corruption could silently reset state
- Status: `Resolved`
- Evidence:
  - `/Users/twoedge/Dev/issuecommand/src/state-persistence.ts`
  - `/Users/twoedge/Dev/issuecommand/tests/state-persistence.test.ts`

### IC-QA-012
- Severity: `P3`
- Title: Runtime still carried optional JSON-backend code paths in docs/config
- Status: `Resolved`
- Evidence:
  - `/Users/twoedge/Dev/issuecommand/src/config.ts`
  - `/Users/twoedge/Dev/issuecommand/src/persistence/create-persistence.ts`
  - `/Users/twoedge/Dev/issuecommand/src/persistence/sqlite-store.ts`
  - `/Users/twoedge/Dev/issuecommand/README.md`
  - `/Users/twoedge/Dev/issuecommand/.env.example`
  - `/Users/twoedge/Dev/issuecommand/tests/persistence-init.test.ts`
  - `/Users/twoedge/Dev/issuecommand/tests/sqlite-store.test.ts`

## 4) Release Recommendation

- Decision: `GO`
- Reason: No unresolved `P0`/`P1` findings; regression coverage and quality gates are passing with updated SQLite-only runtime documentation and tests.
