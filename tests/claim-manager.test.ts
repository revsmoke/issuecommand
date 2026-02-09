import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { ClaimManager } from '../src/claim-manager';
import { Logger } from '../src/logger';
import { ClaimIncrementalPersistence, StatePersistence } from '../src/state-persistence';
import type { ClaimRecord, PersistedState } from '../src/types';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }

    await rm(dir, { recursive: true, force: true });
  }
});

describe('ClaimManager', () => {
  test('enforces exclusivity and idempotent reclaim', async () => {
    const ctx = await createManagerTestContext();

    const firstClaim = await ctx.manager.claimIssue({
      agent_id: 'agent-1',
      repo: 'acme/repo',
      issue_number: 42,
      issue_title: 'Fix auth race',
    });

    expect(firstClaim.ok).toBeTrue();
    expect(firstClaim.idempotent).toBeFalse();

    const secondClaim = await ctx.manager.claimIssue({
      agent_id: 'agent-1',
      repo: 'acme/repo',
      issue_number: 42,
      issue_title: 'Fix auth race',
    });

    expect(secondClaim.ok).toBeTrue();
    expect(secondClaim.idempotent).toBeTrue();

    const rejectedClaim = await ctx.manager.claimIssue({
      agent_id: 'agent-2',
      repo: 'acme/repo',
      issue_number: 42,
      issue_title: 'Fix auth race',
    });

    expect(rejectedClaim.ok).toBeFalse();
    expect(rejectedClaim.reason).toBe('already_claimed');
    expect(rejectedClaim.owner_agent_id).toBe('agent-1');
  });

  test('validates status transitions and requires pr_url for pr_submitted', async () => {
    const ctx = await createManagerTestContext();

    const claimResult = await ctx.manager.claimIssue({
      agent_id: 'agent-1',
      repo: 'acme/repo',
      issue_number: 7,
      issue_title: 'Add retries',
    });

    const claimId = claimResult.claim?.claim_id;
    expect(claimId).toBeDefined();

    const invalidDirectTransition = await ctx.manager.updateClaimStatus({
      claim_id: claimId!,
      agent_id: 'agent-1',
      status: 'pr_submitted',
      source: 'agent',
    });

    expect(invalidDirectTransition.ok).toBeFalse();
    expect(invalidDirectTransition.reason).toBe('invalid_transition');

    const inProgress = await ctx.manager.updateClaimStatus({
      claim_id: claimId!,
      agent_id: 'agent-1',
      status: 'in_progress',
      source: 'agent',
    });

    expect(inProgress.ok).toBeTrue();

    const missingPrUrl = await ctx.manager.updateClaimStatus({
      claim_id: claimId!,
      agent_id: 'agent-1',
      status: 'pr_submitted',
      source: 'agent',
    });

    expect(missingPrUrl.ok).toBeFalse();
    expect(missingPrUrl.reason).toBe('invalid_transition');

    const prSubmitted = await ctx.manager.updateClaimStatus({
      claim_id: claimId!,
      agent_id: 'agent-1',
      status: 'pr_submitted',
      pr_url: 'https://github.com/acme/repo/pull/1',
      source: 'agent',
    });

    expect(prSubmitted.ok).toBeTrue();
    expect(prSubmitted.claim?.pr_url).toBe('https://github.com/acme/repo/pull/1');

    const prMerged = await ctx.manager.updateClaimStatus({
      claim_id: claimId!,
      agent_id: 'agent-1',
      status: 'pr_merged',
      source: 'agent',
    });

    expect(prMerged.ok).toBeTrue();

    const closed = await ctx.manager.updateClaimStatus({
      claim_id: claimId!,
      agent_id: 'agent-1',
      status: 'closed',
      source: 'agent',
    });

    expect(closed.ok).toBeTrue();

    const activeClaims = ctx.manager.getActiveClaims();
    expect(activeClaims.length).toBe(0);

    const history = ctx.manager.getHistory(10);
    expect(history.items.length).toBe(1);
    expect(history.items[0].status).toBe('closed');
  });

  test('marks stale claims and auto releases after stale timeout', async () => {
    const now = createNowController('2026-02-08T00:00:00.000Z');
    const ctx = await createManagerTestContext({
      claimTimeoutMinutes: 10,
      staleAutoReleaseMinutes: 5,
      now: now.now,
    });

    const claimResult = await ctx.manager.claimIssue({
      agent_id: 'agent-1',
      repo: 'acme/repo',
      issue_number: 100,
      issue_title: 'Fix background sync',
    });

    const claimId = claimResult.claim?.claim_id;
    expect(claimId).toBeDefined();

    now.advanceMinutes(11);

    const firstSweep = await ctx.manager.runStaleSweep();
    expect(firstSweep.markedStale).toBe(1);
    expect(firstSweep.autoReleased).toBe(0);

    const staleClaim = ctx.manager.getClaimById(claimId!);
    expect(staleClaim?.status).toBe('stale');

    now.advanceMinutes(6);

    const secondSweep = await ctx.manager.runStaleSweep();
    expect(secondSweep.markedStale).toBe(0);
    expect(secondSweep.autoReleased).toBe(1);

    const activeClaims = ctx.manager.getActiveClaims();
    expect(activeClaims.length).toBe(0);

    const history = ctx.manager.getHistory(10);
    expect(history.items[0].status).toBe('released');
  });

  test('caps history in memory when max entries is reached', async () => {
    const ctx = await createManagerTestContext({
      historyMaxEntries: 2,
    });

    for (let issue = 1; issue <= 3; issue += 1) {
      const claim = await ctx.manager.claimIssue({
        agent_id: `agent-${issue}`,
        repo: 'acme/repo',
        issue_number: issue,
        issue_title: `Issue ${issue}`,
      });
      expect(claim.ok).toBeTrue();

      const closed = await ctx.manager.updateClaimStatus({
        claim_id: claim.claim!.claim_id,
        status: 'closed',
        source: 'sync',
      });
      expect(closed.ok).toBeTrue();
    }

    const history = ctx.manager.getHistory(10);
    expect(history.items.length).toBe(2);
    expect(history.items[0].issue_number).toBe(3);
    expect(history.items[1].issue_number).toBe(2);
  });

  test('trims loaded history to configured max entries during initialization', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-claim-manager-hydrate-'));
    tempDirs.push(tempDir);

    const logger = new Logger({ silent: true });
    const statePath = join(tempDir, 'state.json');
    const startedAt = '2026-02-08T00:00:00.000Z';
    const persistedState: PersistedState = {
      version: 1,
      started_at: startedAt,
      total_claims: 4,
      active_claims: [],
      history: [1, 2, 3, 4].map((issueNumber) =>
        buildHistoricClaim({
          issueNumber,
          timestamp: `2026-02-0${issueNumber}T00:00:00.000Z`,
        }),
      ),
    };
    await writeFile(statePath, JSON.stringify(persistedState, null, 2), 'utf8');

    const persistence = new StatePersistence({
      filePath: statePath,
      logger,
      debounceMs: 5,
    });

    const manager = new ClaimManager({
      claimTimeoutMinutes: 120,
      staleAutoReleaseMinutes: 0,
      historyMaxEntries: 2,
      persistence,
      logger,
    });

    await manager.initialize();

    const history = manager.getHistory(10);
    expect(history.items.length).toBe(2);
    expect(history.items[0].issue_number).toBe(1);
    expect(history.items[1].issue_number).toBe(2);
  });

  test('uses incremental persistence hooks instead of snapshot saves when available', async () => {
    const calls = {
      scheduleSave: 0,
      runtimeUpserts: 0,
      activeUpserts: 0,
      activeDeletes: 0,
      historyUpserts: 0,
      historyTrims: 0,
    };

    const persistence: StatePersistenceLikeWithIncremental = {
      supportsIncrementalClaims: true,
      async load() {
        return null;
      },
      scheduleSave() {
        calls.scheduleSave += 1;
      },
      async flush() {
        // no-op
      },
      runClaimTransaction(fn: () => void) {
        fn();
      },
      upsertClaimRuntime() {
        calls.runtimeUpserts += 1;
      },
      upsertActiveClaim() {
        calls.activeUpserts += 1;
      },
      deleteActiveClaim() {
        calls.activeDeletes += 1;
      },
      upsertClaimHistory() {
        calls.historyUpserts += 1;
      },
      trimClaimHistory() {
        calls.historyTrims += 1;
      },
    };

    const logger = new Logger({ silent: true });
    const manager = new ClaimManager({
      claimTimeoutMinutes: 120,
      staleAutoReleaseMinutes: 0,
      historyMaxEntries: 1000,
      persistence,
      logger,
    });
    await manager.initialize();

    const claim = await manager.claimIssue({
      agent_id: 'agent-incremental',
      repo: 'acme/repo',
      issue_number: 77,
      issue_title: 'Incremental persistence',
    });
    expect(claim.ok).toBeTrue();

    const close = await manager.updateClaimStatus({
      claim_id: claim.claim!.claim_id,
      status: 'closed',
      source: 'sync',
    });
    expect(close.ok).toBeTrue();

    manager.setLastGithubSyncAt('2026-02-08T12:00:00.000Z');

    expect(calls.scheduleSave).toBe(0);
    expect(calls.runtimeUpserts).toBeGreaterThan(0);
    expect(calls.activeUpserts).toBe(1);
    expect(calls.activeDeletes).toBe(1);
    expect(calls.historyUpserts).toBe(1);
    expect(calls.historyTrims).toBe(1);
  });

  test('agent-source update requires agent_id', async () => {
    const ctx = await createManagerTestContext();

    const claim = await ctx.manager.claimIssue({
      agent_id: 'agent-1',
      repo: 'acme/repo',
      issue_number: 701,
      issue_title: 'Test missing agent_id',
    });
    expect(claim.ok).toBeTrue();

    const result = await ctx.manager.updateClaimStatus({
      claim_id: claim.claim!.claim_id,
      status: 'in_progress',
      source: 'agent',
    });

    expect(result.ok).toBeFalse();
    expect(result.reason).toBe('invalid_transition');
    expect(result.message).toContain('agent_id is required');
  });

  test('agent-source update rejects mismatched claim owner', async () => {
    const ctx = await createManagerTestContext();

    const claim = await ctx.manager.claimIssue({
      agent_id: 'agent-owner',
      repo: 'acme/repo',
      issue_number: 702,
      issue_title: 'Test mismatch',
    });
    expect(claim.ok).toBeTrue();

    const result = await ctx.manager.updateClaimStatus({
      claim_id: claim.claim!.claim_id,
      agent_id: 'agent-other',
      status: 'in_progress',
      source: 'agent',
    });

    expect(result.ok).toBeFalse();
    expect(result.reason).toBe('agent_mismatch');
    expect(result.owner_agent_id).toBe('agent-owner');
  });

  test('sync-source update does not require agent_id', async () => {
    const ctx = await createManagerTestContext();

    const claim = await ctx.manager.claimIssue({
      agent_id: 'agent-sync',
      repo: 'acme/repo',
      issue_number: 703,
      issue_title: 'Test sync source',
    });
    expect(claim.ok).toBeTrue();

    const result = await ctx.manager.updateClaimStatus({
      claim_id: claim.claim!.claim_id,
      status: 'in_progress',
      source: 'sync',
    });

    expect(result.ok).toBeTrue();
    expect(result.claim?.status).toBe('in_progress');
  });

  test('agent-source release requires matching agent_id', async () => {
    const ctx = await createManagerTestContext();

    const claim = await ctx.manager.claimIssue({
      agent_id: 'agent-owner',
      repo: 'acme/repo',
      issue_number: 704,
      issue_title: 'Test release ownership',
    });
    expect(claim.ok).toBeTrue();

    const missingAgent = await ctx.manager.releaseIssue({
      claim_id: claim.claim!.claim_id,
      source: 'agent',
    });
    expect(missingAgent.ok).toBeFalse();
    expect(missingAgent.reason).toBe('invalid_transition');

    const mismatch = await ctx.manager.releaseIssue({
      claim_id: claim.claim!.claim_id,
      agent_id: 'agent-other',
      source: 'agent',
    });
    expect(mismatch.ok).toBeFalse();
    expect(mismatch.reason).toBe('agent_mismatch');

    const ownerRelease = await ctx.manager.releaseIssue({
      claim_id: claim.claim!.claim_id,
      agent_id: 'agent-owner',
      source: 'agent',
    });
    expect(ownerRelease.ok).toBeTrue();
    expect(ownerRelease.claim?.status).toBe('released');
  });
});

async function createManagerTestContext(options: {
  claimTimeoutMinutes?: number;
  staleAutoReleaseMinutes?: number;
  historyMaxEntries?: number;
  now?: () => Date;
} = {}): Promise<{ manager: ClaimManager }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-claim-manager-'));
  tempDirs.push(tempDir);

  const logger = new Logger({ silent: true });
  const persistence = new StatePersistence({
    filePath: join(tempDir, 'state.json'),
    logger,
    debounceMs: 5,
  });

  const manager = new ClaimManager({
    claimTimeoutMinutes: options.claimTimeoutMinutes ?? 120,
    staleAutoReleaseMinutes: options.staleAutoReleaseMinutes ?? 0,
    historyMaxEntries: options.historyMaxEntries ?? 1000,
    persistence,
    logger,
    now: options.now,
  });

  await manager.initialize();

  return {
    manager,
  };
}

function createNowController(initialTimestamp: string): {
  now: () => Date;
  advanceMinutes: (minutes: number) => void;
} {
  let currentMs = Date.parse(initialTimestamp);

  return {
    now: () => new Date(currentMs),
    advanceMinutes: (minutes: number) => {
      currentMs += minutes * 60_000;
    },
  };
}

function buildHistoricClaim(input: { issueNumber: number; timestamp: string }): ClaimRecord {
  return {
    claim_id: `claim-${input.issueNumber}`,
    agent_id: `agent-${input.issueNumber}`,
    repo: 'acme/repo',
    issue_number: input.issueNumber,
    issue_title: `Issue ${input.issueNumber}`,
    issue_labels: [],
    issue_assignees: [],
    status: 'closed',
    claimed_at: input.timestamp,
    last_updated: input.timestamp,
    status_history: [
      {
        status: 'claimed',
        timestamp: input.timestamp,
      },
      {
        status: 'closed',
        timestamp: input.timestamp,
      },
    ],
  };
}

type StatePersistenceLikeWithIncremental = {
  load: () => Promise<PersistedState | null>;
  scheduleSave: (state: PersistedState) => void;
  flush: () => Promise<void>;
} & ClaimIncrementalPersistence;
