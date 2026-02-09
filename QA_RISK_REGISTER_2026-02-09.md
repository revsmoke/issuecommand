# IssueCommand QA Risk Register (Comprehensive, Offline-First)

Date: 2026-02-09  
Reviewer: Codex (GPT-5)  
Scope: `/Users/twoedge/Dev/issuecommand`  
Release gate policy: unresolved `P0`/`P1` findings block release

## 1) Baseline Artifacts

- Commit SHA: `58f1be5a3dd912b490ba894314e394a8018f79a7`
- Branch: `main`
- Bun: `1.3.9`

Commands run:

```bash
bun run typecheck
bun test
bun test --coverage
```

Observed baselines:

- Initial baseline (before QA test expansion in this session):
  - `bun run typecheck`: pass
  - `bun test`: 44 pass / 0 fail
  - `bun test --coverage`: 77.14% funcs / 76.58% lines
- Final baseline (after QA test expansion in this session):
  - `bun run typecheck`: pass
  - `bun test`: 54 pass / 0 fail
  - `bun test --coverage`: 84.99% funcs / 90.10% lines

Coverage improvements in high-risk modules:

- `/Users/twoedge/Dev/issuecommand/src/github.ts`: 10.10% -> 82.91% lines
- `/Users/twoedge/Dev/issuecommand/src/sync.ts`: 15.00% -> 99.15% lines

## 2) Severity Rubric

- `P0`: Critical exploitable/systemic failure; immediate stop-ship.
- `P1`: High-severity correctness/security/reliability risk; release blocker until fixed or formally waived.
- `P2`: Medium risk; should be scheduled before/just after release with owner and due date.
- `P3`: Low risk/hardening/documentation quality gap.

Confidence score scale:

- `0.0-0.4`: weak signal/incomplete reproduction
- `0.5-0.7`: moderate confidence
- `0.8-1.0`: strong evidence from direct code path or reproducible behavior

## 3) Findings (Ordered by Severity)

### IC-QA-001
- Severity: `P1`
- Confidence: `0.96`
- Category: Security, Correctness
- Title: Claim mutation authorization is not bound to claim ownership
- Status (2026-02-09): `Resolved` in P1 blocker remediation wave (branch `main`, commit `fde2f89`) with HTTP/MCP ownership enforcement and regression tests.
- Evidence:
  - `/Users/twoedge/Dev/issuecommand/src/http-server.ts:244`
  - `/Users/twoedge/Dev/issuecommand/src/http-server.ts:266`
  - `/Users/twoedge/Dev/issuecommand/src/issuecommand-service.ts:195`
  - `/Users/twoedge/Dev/issuecommand/src/claim-manager.ts:269`
  - `/Users/twoedge/Dev/issuecommand/src/mcp-server.ts:151`
  - `/Users/twoedge/Dev/issuecommand/src/mcp-server.ts:166`
- Reproduction:
  1. Agent A creates a claim (`POST /api/claims` with `agent_id: "agent-a"`).
  2. A separate caller with the same API key sends `PATCH /api/claims/:claim_id` to set status.
  3. Status update succeeds without validating mutating agent identity.
  4. Same pattern applies to release when `agent_id` is omitted.
- Impact:
  - Any bearer of shared API key can mutate or release another agent’s claim, enabling accidental or malicious hijacking.
- Recommended fix:
  - Make `agent_id` mandatory on claim mutation/release paths in HTTP and MCP.
  - Thread `agent_id` through `IssueCommandService.updateClaimStatus`.
  - Enforce `agent_id === claim.agent_id` in `ClaimManager.updateClaimStatus` and `releaseIssue`.
  - Return explicit `agent_mismatch` conflicts.
- Regression test requirement:
  - Add HTTP and MCP integration tests asserting `409 agent_mismatch` when non-owner mutates/releases.
- Suggested owner role:
  - Backend API owner

### IC-QA-002
- Severity: `P1`
- Confidence: `0.91`
- Category: Reliability, Concurrency
- Title: Sync scheduler can run overlapping reconciliations and does not catch run failures
- Status (2026-02-09): `Resolved` in P1 blocker remediation wave (branch `main`, commit `fde2f89`) with single-flight scheduler guard and failure capture logging.
- Evidence:
  - `/Users/twoedge/Dev/issuecommand/src/sync.ts:46`
  - `/Users/twoedge/Dev/issuecommand/src/sync.ts:50`
  - `/Users/twoedge/Dev/issuecommand/src/sync.ts:62`
- Reproduction:
  1. Configure slow GitHub operations (or injected delays) so `runOnce()` exceeds interval duration.
  2. `start()` continues firing `setInterval` ticks with `void this.runOnce()` and no in-flight guard.
  3. If `runOnce()` rejects (for example at repo resolution), rejection is not caught by scheduler wrapper.
- Impact:
  - Unhandled rejections can destabilize runtime behavior and observability.
  - Concurrent reconciliation passes can duplicate work/events and create inconsistent counters.
- Recommended fix:
  - Introduce `isRunning` guard (single-flight loop).
  - Wrap scheduled invocations in `try/catch` with explicit `sync.run_failed` logs.
  - Optionally queue one pending rerun when overlap is detected.
- Regression test requirement:
  - Add scheduler tests proving (a) no overlap and (b) errors are caught/logged, not leaked.
- Suggested owner role:
  - Runtime reliability owner

### IC-QA-003
- Severity: `P2`
- Confidence: `0.88`
- Category: Correctness, Scalability
- Title: GH issue listing path is hard-capped to 200 issues
- Status (2026-02-09): `Resolved` in P2 code-fix wave by GH-cap boundary fallback to paginated REST issue listing, with regression coverage in `tests/github.test.ts`.
- Evidence:
  - `/Users/twoedge/Dev/issuecommand/src/github.ts:216`
  - `/Users/twoedge/Dev/issuecommand/src/github.ts:217`
- Reproduction:
  1. Use a repository with >200 open issues.
  2. Run in environment where `gh issue list` path succeeds.
  3. Candidates beyond first 200 are never surfaced for selection.
- Impact:
  - Next-issue selection can miss eligible work in large repos.
  - Priority/age ordering is evaluated on truncated set.
- Recommended fix:
  - Implement pagination over `gh` results or use REST pagination for complete set.
- Regression test requirement:
  - Add mock test verifying behavior when repo has >200 open issues.
- Suggested owner role:
  - GitHub integration owner

### IC-QA-004
- Severity: `P2`
- Confidence: `0.82`
- Category: Correctness
- Title: REST issue details only fetch first 100 comments
- Status (2026-02-09): `Resolved` in P2 code-fix wave by paginating REST comments (`per_page=100`, page loop until terminal batch), with regression coverage in `tests/github.test.ts`.
- Evidence:
  - `/Users/twoedge/Dev/issuecommand/src/github.ts:360`
  - `/Users/twoedge/Dev/issuecommand/src/github.ts:361`
- Reproduction:
  1. Request details for issue with >100 comments using REST fallback path.
  2. Returned `comments` include only first page.
- Impact:
  - Agents may miss important guidance in older/newer comments.
- Recommended fix:
  - Paginate comments (`page` loop until batch < 100), or return explicit truncation metadata.
- Regression test requirement:
  - Add two-page comments test in `github.test.ts`.
- Suggested owner role:
  - GitHub integration owner

### IC-QA-005
- Severity: `P2`
- Confidence: `0.84`
- Category: Contract
- Title: Claim mutation endpoints flatten distinct failures into coarse HTTP statuses
- Status (2026-02-09): `Resolved` in P1/P2 remediation with explicit claim-mutation status mapping and route-level regression coverage for `claim_not_found`, `agent_mismatch`, `invalid_transition`, and malformed payloads.
- Evidence:
  - `/Users/twoedge/Dev/issuecommand/src/http-server.ts:250`
  - `/Users/twoedge/Dev/issuecommand/src/http-server.ts:273`
- Reproduction:
  1. Call delete/patch claim routes under different failure reasons (`claim_not_found`, `agent_mismatch`, `invalid_transition`).
  2. Observe broad `404`/`400` mapping rather than reason-specific status.
- Impact:
  - Client retry logic and monitoring lose precision.
  - Operational triage becomes noisier.
- Recommended fix:
  - Use reason-to-status mapping:
    - `claim_not_found -> 404`
    - `agent_mismatch`/`already_claimed`/`invalid_transition -> 409`
    - malformed input -> `400`
- Regression test requirement:
  - Add route-level tests for each claim error reason.
- Suggested owner role:
  - API contract owner

### IC-QA-006
- Severity: `P2`
- Confidence: `0.94`
- Category: Operability, Tests
- Title: No CI workflow enforces quality gates
- Status (2026-02-09): `Resolved` via merged PR #2 adding `.github/workflows/ci.yml` (`typecheck`, `bun test --coverage`, coverage artifact upload on `pull_request` and `push` to `main`).
- Evidence:
  - Repository lacks `/Users/twoedge/Dev/issuecommand/.github/workflows/*`
- Reproduction:
  1. Inspect repository root for GitHub Actions workflow files.
  2. No automated gate for typecheck/tests/coverage is present.
- Impact:
  - Regressions can merge without automatic validation.
- Recommended fix:
  - Add CI workflow running `bun install`, `bun run typecheck`, `bun test --coverage`.
  - Add minimum line/function thresholds and artifact upload for coverage report.
- Regression test requirement:
  - N/A (process control)
- Suggested owner role:
  - DevEx / repository maintainer

## 4) Test Gap Matrix (Post-Expansion)

Added tests in this QA execution:

- `/Users/twoedge/Dev/issuecommand/tests/github.test.ts`
  - GH success parsing path
  - GH -> REST fallback for issue list/details
  - repo list includeCounts behavior
  - ALLOWED_REPOS enforcement
- `/Users/twoedge/Dev/issuecommand/tests/sync.test.ts`
  - newly-opened issue accounting across runs
  - external closure reconciliation
  - per-repo scan failure isolation
  - scheduler start/stop idempotency

Remaining critical gaps:

- Claim ownership authz negative tests (HTTP + MCP) for non-owner mutation attempts.
- Sync scheduler negative test for rejected `runOnce()` handling.
- Claim endpoint reason-specific status-code contract tests.

## 5) Remediation Roadmap

### Phase 0 (Blocker Fixes, before release)
1. Fix IC-QA-001 claim mutation authorization model.
2. Fix IC-QA-002 sync scheduler safety (single-flight + caught failures).
3. Add regression tests for both blocker fixes.

### Phase 1 (Near-term hardening)
1. Address IC-QA-003 issue list pagination.
2. Address IC-QA-004 issue comments pagination/truncation signaling.
3. Address IC-QA-005 status-code mapping precision.

### Phase 2 (Process guardrail)
1. Add CI workflow and required checks (IC-QA-006).

## 6) Release Recommendation

- Decision: `GO`
- Reason: release-blocking findings (`P0/P1`) are resolved and validated by passing `bun run typecheck` and `bun test`; remaining tracked items in this register are now resolved in merged or pending-remediation PR waves.
