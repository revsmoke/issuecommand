# P2 Remediation Roadmap (Post-P1 Gate)

This document tracks deferred P2 items from `QA_RISK_REGISTER_2026-02-09.md` after the P1 blocker release gate was cleared.

## Scope

- IC-QA-003: GH issue listing capped at 200 items
- IC-QA-004: REST issue details comments capped at first 100
- IC-QA-005: Claim mutation error-to-HTTP status mapping precision
- IC-QA-006: Missing CI workflow for typecheck/tests/coverage gates

## Work Items

### 1) IC-QA-003: Remove GH 200-issue cap

- [ ] Add paging strategy for `gh issue list` path in `src/github.ts`.
- [ ] Keep existing GH-first behavior; preserve REST fallback.
- [ ] Add tests proving >200 open issues can be enumerated.
- [ ] Confirm `nextIssue` selection remains priority/age-correct across full set.

## 2) IC-QA-004: Paginate issue comments in REST details path

- [ ] Update REST comment retrieval in `src/github.ts` to iterate pages until exhaustion.
- [ ] Add tests covering multi-page comment fetches.
- [ ] Validate shape parity with GH path comments output.

## 3) IC-QA-005: Tighten claim mutation HTTP status contract

- [ ] Audit claim mutation responses in `src/http-server.ts`.
- [ ] Ensure stable mapping:
  - `claim_not_found` -> 404
  - `agent_mismatch` -> 409
  - `invalid_transition` -> 409
  - malformed payload -> 400
- [ ] Add route-level tests for each reason branch.

## 4) IC-QA-006: Add CI quality gate

- [ ] Add GitHub Actions workflow under `.github/workflows/ci.yml`.
- [ ] Run `bun install`, `bun run typecheck`, `bun test --coverage`.
- [ ] Fail workflow on command failure.
- [ ] Publish coverage artifact for traceability.

## Exit Criteria

- [ ] `bun run typecheck` passes.
- [ ] `bun test` passes.
- [ ] New/updated tests cover IC-QA-003/004/005 scenarios.
- [ ] CI workflow runs successfully on PR and main.
- [ ] QA risk register updated with P2 status and verification evidence.
