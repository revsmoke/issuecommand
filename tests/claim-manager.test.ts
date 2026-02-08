import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { ClaimManager } from '../src/claim-manager';
import { Logger } from '../src/logger';
import { StatePersistence } from '../src/state-persistence';

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
      status: 'pr_submitted',
      source: 'agent',
    });

    expect(invalidDirectTransition.ok).toBeFalse();
    expect(invalidDirectTransition.reason).toBe('invalid_transition');

    const inProgress = await ctx.manager.updateClaimStatus({
      claim_id: claimId!,
      status: 'in_progress',
      source: 'agent',
    });

    expect(inProgress.ok).toBeTrue();

    const missingPrUrl = await ctx.manager.updateClaimStatus({
      claim_id: claimId!,
      status: 'pr_submitted',
      source: 'agent',
    });

    expect(missingPrUrl.ok).toBeFalse();
    expect(missingPrUrl.reason).toBe('invalid_transition');

    const prSubmitted = await ctx.manager.updateClaimStatus({
      claim_id: claimId!,
      status: 'pr_submitted',
      pr_url: 'https://github.com/acme/repo/pull/1',
      source: 'agent',
    });

    expect(prSubmitted.ok).toBeTrue();
    expect(prSubmitted.claim?.pr_url).toBe('https://github.com/acme/repo/pull/1');

    const prMerged = await ctx.manager.updateClaimStatus({
      claim_id: claimId!,
      status: 'pr_merged',
      source: 'agent',
    });

    expect(prMerged.ok).toBeTrue();

    const closed = await ctx.manager.updateClaimStatus({
      claim_id: claimId!,
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
});

async function createManagerTestContext(options: {
  claimTimeoutMinutes?: number;
  staleAutoReleaseMinutes?: number;
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
