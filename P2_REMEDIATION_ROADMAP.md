# P2 Remediation Roadmap (Updated 2026-02-09)

This file tracks the historical P2 backlog and its current status.

## Historical Scope Status

### IC-QA-003: Remove GH 200-issue cap

- [x] Add GH cap-boundary handling with full paginated REST fallback in `src/github.ts`.
- [x] Preserve GH-first behavior while ensuring complete enumeration when cap is reached.
- [x] Add tests proving >200 issues can be surfaced through fallback behavior.
- [x] Validate `nextIssue` still sorts by priority then age over returned candidates.

### IC-QA-004: Paginate issue comments in REST details path

- [x] REST comments now paginate with `per_page=100` until exhaustion in `src/github.ts`.
- [x] Add tests for multi-page comment retrieval.
- [x] Validate output parity with GH issue-details path contract.

### IC-QA-005: Tighten claim mutation HTTP status contract

- [x] Claim mutation reason-to-status mapping audited and implemented in `src/http-server.ts`.
- [x] `claim_not_found -> 404`.
- [x] `agent_mismatch` / `invalid_transition` / `already_claimed -> 409`.
- [x] Malformed payload / client validation errors -> `400`.
- [x] Route-level tests cover reason-specific branches.

### IC-QA-006: CI quality gate

- [x] GitHub Actions workflow added at `.github/workflows/ci.yml`.
- [x] Runs `bun install --frozen-lockfile`, `bun run typecheck`, `bun test --coverage`.
- [x] Workflow fails on command failure.
- [x] Coverage summary artifact upload enabled.

## Additional Completion Wave (Post-Review)

- [x] Fixed follow-up dedupe regression across restart/history trimming (`src/followup-manager.ts`).
- [x] Added shutdown-safe sync/follow-up background stop semantics (`src/sync.ts`, `src/followup-sweep-scheduler.ts`, `src/index.ts`).
- [x] Hardened HTTP error contract (`400` client validation vs `500` internal) with no internal message leakage.
- [x] Added mutation throttling keyed to authenticated principal in addition to `agent_id`.
- [x] Enforced fail-fast behavior on corrupted JSON state loader (`src/state-persistence.ts`).
- [x] Simplified runtime to SQLite-only persistence initialization (`src/persistence/create-persistence.ts`, config/docs/tests).

## Current Exit Criteria

- [x] `bun run typecheck` passes.
- [x] `bun test` passes.
- [x] `bun test --coverage` passes.
- [x] Regression tests added for post-review fixes.
- [x] Notes and risk documentation updated to reflect current codebase state.
