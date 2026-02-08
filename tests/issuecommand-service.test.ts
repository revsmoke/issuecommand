import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { ClaimManager } from '../src/claim-manager';
import { IssueCommandService } from '../src/issuecommand-service';
import { Logger } from '../src/logger';
import { StatePersistence } from '../src/state-persistence';
import { buildIssue, FakeGitHubClient } from './test-helpers';

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

describe('IssueCommandService', () => {
  test('nextIssue uses label priority then age ordering', async () => {
    const github = new FakeGitHubClient({
      issues: [
        buildIssue({
          repo: 'acme/api',
          number: 10,
          labels: ['P1'],
          created_at: '2026-02-01T00:00:00.000Z',
        }),
        buildIssue({
          repo: 'acme/api',
          number: 11,
          labels: ['P0'],
          created_at: '2026-02-07T00:00:00.000Z',
        }),
        buildIssue({
          repo: 'acme/web',
          number: 12,
          labels: [],
          created_at: '2026-01-15T00:00:00.000Z',
        }),
      ],
    });

    const service = await createServiceTestContext(github, { autoCloseGithubIssue: false });

    const result = await service.nextIssue({
      agent_id: 'agent-1',
    });

    expect(result.ok).toBeTrue();
    expect(result.issue?.number).toBe(11);
    expect(result.claim?.status).toBe('claimed');

    const listResponse = await service.listOpenIssues({ repo: 'acme/api' });
    const remainingIssueNumbers = listResponse.issues.map((issue) => issue.number).sort();
    expect(remainingIssueNumbers).toEqual([10]);
  });

  test('closed status can trigger GitHub issue close when enabled', async () => {
    const github = new FakeGitHubClient({
      issues: [
        buildIssue({
          repo: 'acme/api',
          number: 99,
          labels: ['P0'],
        }),
      ],
    });

    const service = await createServiceTestContext(github, { autoCloseGithubIssue: true });

    const claim = await service.claimIssue({
      agent_id: 'agent-1',
      repo: 'acme/api',
      issue_number: 99,
    });

    const claimId = claim.claim?.claim_id;
    expect(claimId).toBeDefined();

    await service.updateClaimStatus({
      claim_id: claimId!,
      status: 'in_progress',
    });

    await service.updateClaimStatus({
      claim_id: claimId!,
      status: 'pr_submitted',
      pr_url: 'https://github.com/acme/api/pull/10',
    });

    await service.updateClaimStatus({
      claim_id: claimId!,
      status: 'pr_merged',
    });

    const closedResult = await service.updateClaimStatus({
      claim_id: claimId!,
      status: 'closed',
    });

    expect(closedResult.ok).toBeTrue();
    expect(closedResult.issue_closed).toBeTrue();

    const issue = await github.getIssueDetails('acme/api', 99);
    expect(issue.state).toBe('closed');
  });
});

async function createServiceTestContext(
  github: FakeGitHubClient,
  options: { autoCloseGithubIssue: boolean },
): Promise<IssueCommandService> {
  const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-service-'));
  tempDirs.push(tempDir);

  const logger = new Logger({ silent: true });
  const persistence = new StatePersistence({
    filePath: join(tempDir, 'state.json'),
    logger,
    debounceMs: 5,
  });

  const claimManager = new ClaimManager({
    claimTimeoutMinutes: 120,
    staleAutoReleaseMinutes: 0,
    persistence,
    logger,
  });

  await claimManager.initialize();

  return new IssueCommandService({
    claims: claimManager,
    github,
    logger,
    autoCloseGithubIssue: options.autoCloseGithubIssue,
  });
}
