import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { ClaimManager } from '../src/claim-manager';
import { startHttpServer } from '../src/http-server';
import { IssueCommandService } from '../src/issuecommand-service';
import { Logger } from '../src/logger';
import { StatePersistence } from '../src/state-persistence';
import { SyncService } from '../src/sync';
import type { AppConfig } from '../src/types';
import { buildIssue, FakeGitHubClient } from './test-helpers';

interface TestContext {
  baseUrl: string;
  apiKey: string;
  stop: () => void;
  tempDir: string;
}

const contexts: TestContext[] = [];

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop();
    if (!context) {
      continue;
    }

    context.stop();
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

describe('HTTP server integration', () => {
  test('requires API key for protected endpoints', async () => {
    const context = await createHttpTestContext();

    const response = await fetch(`${context.baseUrl}/api/health`);
    expect(response.status).toBe(401);

    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe('unauthorized');
  });

  test('claim conflicts are rejected and claimed issues are filtered from issue lists', async () => {
    const context = await createHttpTestContext();

    const claimSuccess = await fetch(`${context.baseUrl}/api/claims`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${context.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'agent-1',
        repo: 'acme/api',
        issue_number: 1,
      }),
    });

    expect(claimSuccess.status).toBe(200);
    const claimSuccessBody = (await claimSuccess.json()) as { ok: boolean; claim?: { claim_id: string } };
    expect(claimSuccessBody.ok).toBeTrue();

    const claimConflict = await fetch(`${context.baseUrl}/api/claims`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${context.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'agent-2',
        repo: 'acme/api',
        issue_number: 1,
      }),
    });

    expect(claimConflict.status).toBe(409);
    const claimConflictBody = (await claimConflict.json()) as { ok: boolean; reason: string; owner_agent_id: string };
    expect(claimConflictBody.ok).toBeFalse();
    expect(claimConflictBody.reason).toBe('already_claimed');
    expect(claimConflictBody.owner_agent_id).toBe('agent-1');

    const issueList = await fetch(`${context.baseUrl}/api/repos/acme/api/issues`, {
      headers: {
        Authorization: `Bearer ${context.apiKey}`,
      },
    });

    expect(issueList.status).toBe(200);

    const issueListBody = (await issueList.json()) as { issues: Array<{ number: number }> };
    const issueNumbers = issueListBody.issues.map((issue) => issue.number).sort((left, right) => left - right);

    expect(issueNumbers).toEqual([2]);
  });
});

async function createHttpTestContext(): Promise<TestContext> {
  const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-http-'));

  const apiKey = 'test-api-key';
  const logger = new Logger({ silent: true });
  const persistence = new StatePersistence({
    filePath: join(tempDir, 'state.json'),
    logger,
    debounceMs: 5,
  });

  const claims = new ClaimManager({
    claimTimeoutMinutes: 120,
    staleAutoReleaseMinutes: 0,
    persistence,
    logger,
  });
  await claims.initialize();

  const github = new FakeGitHubClient({
    repos: [{ full_name: 'acme/api' }],
    issues: [
      buildIssue({ repo: 'acme/api', number: 1, labels: ['P0'] }),
      buildIssue({ repo: 'acme/api', number: 2, labels: ['P1'] }),
    ],
  });

  const service = new IssueCommandService({
    claims,
    github,
    logger,
    autoCloseGithubIssue: false,
  });

  const config: AppConfig = {
    githubToken: 'unused-in-tests',
    httpPort: 0,
    claimTimeoutMinutes: 120,
    staleAutoReleaseMinutes: 0,
    stateFilePath: join(tempDir, 'state.json'),
    syncIntervalMinutes: 60,
    allowedRepos: new Set<string>(),
    logFile: undefined,
    apiKey,
    autoCloseGithubIssue: false,
  };

  const sync = new SyncService({
    claims,
    github,
    logger,
    intervalMinutes: config.syncIntervalMinutes,
    allowedRepos: config.allowedRepos,
  });

  const server = startHttpServer({
    service,
    claims,
    sync,
    config,
    logger,
  });

  const context: TestContext = {
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiKey,
    stop: () => {
      sync.stop();
      server.stop();
    },
    tempDir,
  };

  contexts.push(context);

  return context;
}
