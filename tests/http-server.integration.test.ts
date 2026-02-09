import { afterEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { ClaimManager } from '../src/claim-manager';
import { FollowupManager } from '../src/followup-manager';
import { GitHubWebhookConnector } from '../src/github-webhook';
import { startHttpServer } from '../src/http-server';
import { IssueCommandService } from '../src/issuecommand-service';
import { Logger } from '../src/logger';
import { StatePersistence } from '../src/state-persistence';
import { SyncService } from '../src/sync';
import type { AppConfig, FollowupPersistedState, GitHubIssue } from '../src/types';
import { buildIssue, FakeGitHubClient } from './test-helpers';

interface TestContext {
  baseUrl: string;
  apiKey: string;
  stop: () => void;
  tempDir: string;
}

interface TestContextOptions {
  issues?: GitHubIssue[];
  rateLimit?: Partial<AppConfig['rateLimit']>;
  trustProxy?: boolean;
  webhookSecret?: string;
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
        ...authorizedHeaders(context.apiKey),
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
        ...authorizedHeaders(context.apiKey),
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
      headers: authorizedHeaders(context.apiKey),
    });

    expect(issueList.status).toBe(200);

    const issueListBody = (await issueList.json()) as { issues: Array<{ number: number }> };
    const issueNumbers = issueListBody.issues.map((issue) => issue.number).sort((left, right) => left - right);

    expect(issueNumbers).toEqual([2]);
  });

  test('claim mutation routes require agent_id and enforce ownership', async () => {
    const context = await createHttpTestContext();

    const claimResponse = await fetch(`${context.baseUrl}/api/claims`, {
      method: 'POST',
      headers: {
        ...authorizedHeaders(context.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'agent-owner',
        repo: 'acme/api',
        issue_number: 1,
      }),
    });
    expect(claimResponse.status).toBe(200);
    const claimPayload = (await claimResponse.json()) as { ok: boolean; claim?: { claim_id: string } };
    expect(claimPayload.ok).toBeTrue();
    const claimId = claimPayload.claim?.claim_id as string;
    expect(claimId).toBeTruthy();

    const patchMissingAgent = await fetch(`${context.baseUrl}/api/claims/${claimId}`, {
      method: 'PATCH',
      headers: {
        ...authorizedHeaders(context.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        status: 'in_progress',
      }),
    });
    expect(patchMissingAgent.status).toBe(400);

    const deleteMissingAgent = await fetch(`${context.baseUrl}/api/claims/${claimId}`, {
      method: 'DELETE',
      headers: {
        ...authorizedHeaders(context.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(deleteMissingAgent.status).toBe(400);

    const patchMismatch = await fetch(`${context.baseUrl}/api/claims/${claimId}`, {
      method: 'PATCH',
      headers: {
        ...authorizedHeaders(context.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'agent-other',
        status: 'in_progress',
      }),
    });
    expect(patchMismatch.status).toBe(409);
    const patchMismatchPayload = (await patchMismatch.json()) as {
      ok: boolean;
      reason?: string;
      owner_agent_id?: string;
    };
    expect(patchMismatchPayload.ok).toBeFalse();
    expect(patchMismatchPayload.reason).toBe('agent_mismatch');
    expect(patchMismatchPayload.owner_agent_id).toBe('agent-owner');

    const deleteMismatch = await fetch(`${context.baseUrl}/api/claims/${claimId}`, {
      method: 'DELETE',
      headers: {
        ...authorizedHeaders(context.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'agent-other',
      }),
    });
    expect(deleteMismatch.status).toBe(409);
    const deleteMismatchPayload = (await deleteMismatch.json()) as { ok: boolean; reason?: string };
    expect(deleteMismatchPayload.ok).toBeFalse();
    expect(deleteMismatchPayload.reason).toBe('agent_mismatch');

    const patchOwner = await fetch(`${context.baseUrl}/api/claims/${claimId}`, {
      method: 'PATCH',
      headers: {
        ...authorizedHeaders(context.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'agent-owner',
        status: 'in_progress',
      }),
    });
    expect(patchOwner.status).toBe(200);
    const patchOwnerPayload = (await patchOwner.json()) as { ok: boolean; claim?: { status: string } };
    expect(patchOwnerPayload.ok).toBeTrue();
    expect(patchOwnerPayload.claim?.status).toBe('in_progress');

    const deleteOwner = await fetch(`${context.baseUrl}/api/claims/${claimId}`, {
      method: 'DELETE',
      headers: {
        ...authorizedHeaders(context.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'agent-owner',
      }),
    });
    expect(deleteOwner.status).toBe(200);
    const deleteOwnerPayload = (await deleteOwner.json()) as { ok: boolean; claim?: { status: string } };
    expect(deleteOwnerPayload.ok).toBeTrue();
    expect(deleteOwnerPayload.claim?.status).toBe('released');

    const deleteNotFound = await fetch(`${context.baseUrl}/api/claims/missing-claim`, {
      method: 'DELETE',
      headers: {
        ...authorizedHeaders(context.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'agent-owner',
      }),
    });
    expect(deleteNotFound.status).toBe(404);
  });

  test('POST /api/next mirrors MCP convenience claim flow', async () => {
    const context = await createHttpTestContext({
      issues: [
        buildIssue({ repo: 'acme/api', number: 10, labels: ['P0'] }),
        buildIssue({ repo: 'acme/api', number: 11, labels: ['P1'] }),
      ],
    });

    const nextResponse = await fetch(`${context.baseUrl}/api/next`, {
      method: 'POST',
      headers: {
        ...authorizedHeaders(context.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'agent-next-1',
        repo: 'acme/api',
      }),
    });

    expect(nextResponse.status).toBe(200);
    const nextPayload = (await nextResponse.json()) as {
      ok: boolean;
      claim?: { issue_number: number };
      issue?: { number: number };
    };

    expect(nextPayload.ok).toBeTrue();
    expect(nextPayload.issue?.number).toBe(10);

    const issueList = await fetch(`${context.baseUrl}/api/repos/acme/api/issues`, {
      headers: authorizedHeaders(context.apiKey),
    });
    const issueListBody = (await issueList.json()) as { issues: Array<{ number: number }> };
    expect(issueListBody.issues.map((issue) => issue.number)).toEqual([11]);

    const nextResponse2 = await fetch(`${context.baseUrl}/api/next`, {
      method: 'POST',
      headers: {
        ...authorizedHeaders(context.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'agent-next-2',
        repo: 'acme/api',
      }),
    });
    expect(nextResponse2.status).toBe(200);

    const nextResponse3 = await fetch(`${context.baseUrl}/api/next`, {
      method: 'POST',
      headers: {
        ...authorizedHeaders(context.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'agent-next-3',
        repo: 'acme/api',
      }),
    });

    expect(nextResponse3.status).toBe(409);
    const nextPayload3 = (await nextResponse3.json()) as { ok: boolean; message?: string };
    expect(nextPayload3.ok).toBeFalse();
    expect(nextPayload3.message).toContain('No eligible unclaimed issues found');
  });

  test('POST /api/webhooks/github accepts signed review events and POST /api/next-work prioritizes followups', async () => {
    const webhookSecret = 'webhook-test-secret';
    const context = await createHttpTestContext({
      webhookSecret,
      issues: [
        buildIssue({ repo: 'acme/api', number: 10, labels: ['P0'] }),
      ],
    });

    const payload = JSON.stringify({
      action: 'submitted',
      repository: { full_name: 'acme/api' },
      pull_request: {
        number: 501,
        html_url: 'https://github.com/acme/api/pull/501',
        title: 'Improve webhook worker',
      },
      review: {
        id: 7001,
        state: 'changes_requested',
        body: 'Please handle retry edge cases',
        user: { login: 'reviewer-1' },
      },
    });

    const webhookResponse = await fetch(`${context.baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'pull_request_review',
        'x-github-delivery': 'delivery-1',
        'x-hub-signature-256': signWebhookPayload(webhookSecret, payload),
      },
      body: payload,
    });
    expect(webhookResponse.status).toBe(202);

    const nextWorkResponse = await fetch(`${context.baseUrl}/api/next-work`, {
      method: 'POST',
      headers: {
        ...authorizedHeaders(context.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'agent-followup-1',
        repo: 'acme/api',
      }),
    });

    expect(nextWorkResponse.status).toBe(200);
    const nextWorkPayload = (await nextWorkResponse.json()) as {
      ok: boolean;
      kind: string;
      work_item?: { repo: string; pr_number: number; status: string };
    };
    expect(nextWorkPayload.ok).toBeTrue();
    expect(nextWorkPayload.kind).toBe('pr_followup');
    expect(nextWorkPayload.work_item?.repo).toBe('acme/api');
    expect(nextWorkPayload.work_item?.pr_number).toBe(501);
    expect(nextWorkPayload.work_item?.status).toBe('claimed');
  });

  test('PATCH /api/followups/:work_item_id updates followup status for claiming agent', async () => {
    const webhookSecret = 'webhook-test-secret';
    const context = await createHttpTestContext({
      webhookSecret,
    });

    const payload = JSON.stringify({
      action: 'created',
      repository: { full_name: 'acme/api' },
      issue: {
        number: 600,
        html_url: 'https://github.com/acme/api/pull/600',
        title: 'PR title from issue comment',
        pull_request: {},
      },
      comment: {
        id: 9100,
        body: 'Please address this comment',
        user: { login: 'reviewer-2' },
      },
    });

    const webhookResponse = await fetch(`${context.baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'delivery-2',
        'x-hub-signature-256': signWebhookPayload(webhookSecret, payload),
      },
      body: payload,
    });
    expect(webhookResponse.status).toBe(202);

    const nextWorkResponse = await fetch(`${context.baseUrl}/api/next-work`, {
      method: 'POST',
      headers: {
        ...authorizedHeaders(context.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'agent-followup-2',
        repo: 'acme/api',
      }),
    });

    const nextWorkPayload = (await nextWorkResponse.json()) as {
      ok: boolean;
      kind: string;
      work_item?: { work_item_id: string };
    };
    expect(nextWorkPayload.ok).toBeTrue();
    expect(nextWorkPayload.kind).toBe('pr_followup');

    const workItemId = nextWorkPayload.work_item?.work_item_id;
    expect(workItemId).toBeTruthy();

    const updateResponse = await fetch(`${context.baseUrl}/api/followups/${workItemId}`, {
      method: 'PATCH',
      headers: {
        ...authorizedHeaders(context.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'agent-followup-2',
        status: 'done',
        note: 'Addressed review comment',
      }),
    });

    expect(updateResponse.status).toBe(200);
    const updatePayload = (await updateResponse.json()) as {
      ok: boolean;
      work_item?: { status: string };
    };
    expect(updatePayload.ok).toBeTrue();
    expect(updatePayload.work_item?.status).toBe('done');

    const listResponse = await fetch(`${context.baseUrl}/api/followups`, {
      headers: authorizedHeaders(context.apiKey),
    });
    const listPayload = (await listResponse.json()) as { followups: Array<{ work_item_id: string }> };
    expect(listPayload.followups.some((item) => item.work_item_id === workItemId)).toBeFalse();
  });

  test('PATCH /api/followups/:work_item_id rejects terminal updates before followup is claimed', async () => {
    const webhookSecret = 'webhook-test-secret';
    const context = await createHttpTestContext({
      webhookSecret,
    });

    const payload = JSON.stringify({
      action: 'created',
      repository: { full_name: 'acme/api' },
      issue: {
        number: 601,
        html_url: 'https://github.com/acme/api/pull/601',
        title: 'PR title from issue comment',
        pull_request: {},
      },
      comment: {
        id: 9101,
        body: 'Please address this comment',
        user: { login: 'reviewer-2' },
      },
    });

    const webhookResponse = await fetch(`${context.baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'delivery-3',
        'x-hub-signature-256': signWebhookPayload(webhookSecret, payload),
      },
      body: payload,
    });
    expect(webhookResponse.status).toBe(202);

    const followupsResponse = await fetch(`${context.baseUrl}/api/followups`, {
      headers: authorizedHeaders(context.apiKey),
    });
    expect(followupsResponse.status).toBe(200);
    const followupsPayload = (await followupsResponse.json()) as {
      followups: Array<{ work_item_id: string; status: string }>;
    };
    expect(followupsPayload.followups.length).toBeGreaterThan(0);
    const workItemId = followupsPayload.followups[0].work_item_id;
    expect(followupsPayload.followups[0].status).toBe('queued');

    const updateResponse = await fetch(`${context.baseUrl}/api/followups/${workItemId}`, {
      method: 'PATCH',
      headers: {
        ...authorizedHeaders(context.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'agent-followup-3',
        status: 'done',
      }),
    });
    expect(updateResponse.status).toBe(409);
    const updatePayload = (await updateResponse.json()) as { ok: boolean; reason?: string };
    expect(updatePayload.ok).toBeFalse();
    expect(updatePayload.reason).toBe('invalid_transition');
  });

  test('webhook endpoint rejects unsigned payloads', async () => {
    const context = await createHttpTestContext({
      webhookSecret: 'webhook-test-secret',
    });

    const response = await fetch(`${context.baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'pull_request_review',
      },
      body: JSON.stringify({ action: 'submitted' }),
    });

    expect(response.status).toBe(401);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe('unauthorized_webhook');
  });

  test('per-IP rate limit returns 429', async () => {
    const context = await createHttpTestContext({
      rateLimit: {
        ipPerMinute: 1,
        ipBurst: 1,
        agentMutationsPerMinute: 200,
        agentMutationsBurst: 200,
      },
    });

    const first = await fetch(`${context.baseUrl}/api/health`, {
      headers: authorizedHeaders(context.apiKey),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${context.baseUrl}/api/health`, {
      headers: authorizedHeaders(context.apiKey),
    });
    expect(second.status).toBe(429);

    const body = (await second.json()) as { error: string; scope: string };
    expect(body.error).toBe('rate_limited');
    expect(body.scope).toBe('ip');
    expect(second.headers.get('Retry-After')).toBeTruthy();
  });

  test('does not trust forwarded headers when TRUST_PROXY is false', async () => {
    const context = await createHttpTestContext({
      trustProxy: false,
      rateLimit: {
        ipPerMinute: 1,
        ipBurst: 1,
        agentMutationsPerMinute: 200,
        agentMutationsBurst: 200,
      },
    });

    const first = await fetch(`${context.baseUrl}/api/health`, {
      headers: {
        ...authorizedHeaders(context.apiKey),
        'x-forwarded-for': '1.2.3.4',
      },
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${context.baseUrl}/api/health`, {
      headers: {
        ...authorizedHeaders(context.apiKey),
        'x-forwarded-for': '5.6.7.8',
      },
    });
    expect(second.status).toBe(429);
  });

  test('uses forwarded headers when TRUST_PROXY is true', async () => {
    const context = await createHttpTestContext({
      trustProxy: true,
      rateLimit: {
        ipPerMinute: 1,
        ipBurst: 1,
        agentMutationsPerMinute: 200,
        agentMutationsBurst: 200,
      },
    });

    const first = await fetch(`${context.baseUrl}/api/health`, {
      headers: {
        ...authorizedHeaders(context.apiKey),
        'x-forwarded-for': '1.2.3.4',
      },
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${context.baseUrl}/api/health`, {
      headers: {
        ...authorizedHeaders(context.apiKey),
        'x-forwarded-for': '5.6.7.8',
      },
    });
    expect(second.status).toBe(200);
  });

  test('per-agent mutation limiter throttles claim-mutating routes', async () => {
    const context = await createHttpTestContext({
      issues: [
        buildIssue({ repo: 'acme/api', number: 20, labels: ['P0'] }),
        buildIssue({ repo: 'acme/api', number: 21, labels: ['P0'] }),
      ],
      rateLimit: {
        ipPerMinute: 200,
        ipBurst: 200,
        agentMutationsPerMinute: 1,
        agentMutationsBurst: 1,
      },
    });

    const first = await fetch(`${context.baseUrl}/api/next`, {
      method: 'POST',
      headers: {
        ...authorizedHeaders(context.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'agent-rate-limit',
        repo: 'acme/api',
      }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${context.baseUrl}/api/next`, {
      method: 'POST',
      headers: {
        ...authorizedHeaders(context.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'agent-rate-limit',
        repo: 'acme/api',
      }),
    });
    expect(second.status).toBe(429);

    const body = (await second.json()) as { error: string; scope: string };
    expect(body.error).toBe('rate_limited');
    expect(body.scope).toBe('agent_mutation');
  });

  test('SSE endpoint uses connection-attempt limiting', async () => {
    const context = await createHttpTestContext({
      rateLimit: {
        ipPerMinute: 200,
        ipBurst: 200,
        sseConnectPerMinute: 1,
        sseConnectBurst: 1,
      },
    });

    const controller = new AbortController();
    const first = await fetch(`${context.baseUrl}/sse`, {
      headers: authorizedHeaders(context.apiKey),
      signal: controller.signal,
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${context.baseUrl}/sse`, {
      headers: authorizedHeaders(context.apiKey),
    });
    expect(second.status).toBe(429);

    const secondBody = (await second.json()) as { error: string; scope: string };
    expect(secondBody.error).toBe('rate_limited');
    expect(secondBody.scope).toBe('sse_connect');

    controller.abort();
    await first.body?.cancel();
  });
});

async function createHttpTestContext(options: TestContextOptions = {}): Promise<TestContext> {
  const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-http-'));

  const apiKey = 'test-api-key';
  const logger = new Logger({ silent: true });
  const persistence = new StatePersistence({
    filePath: join(tempDir, 'state.json'),
    logger,
    debounceMs: 5,
  });
  const followupPersistence = new StatePersistence<FollowupPersistedState>({
    filePath: join(tempDir, 'followups-state.json'),
    logger,
    debounceMs: 5,
  });

  const claims = new ClaimManager({
    claimTimeoutMinutes: 120,
    staleAutoReleaseMinutes: 0,
    historyMaxEntries: 1000,
    persistence,
    logger,
  });
  await claims.initialize();

  const followups = new FollowupManager({
    persistence: followupPersistence,
    logger,
    maxEntries: 1000,
    staleMinutes: 1440,
  });
  await followups.initialize();

  const github = new FakeGitHubClient({
    repos: [{ full_name: 'acme/api' }],
    issues:
      options.issues ?? [
        buildIssue({ repo: 'acme/api', number: 1, labels: ['P0'] }),
        buildIssue({ repo: 'acme/api', number: 2, labels: ['P1'] }),
      ],
  });

  const service = new IssueCommandService({
    claims,
    followups,
    github,
    logger,
    autoCloseGithubIssue: false,
  });

  const config: AppConfig = {
    githubToken: 'unused-in-tests',
    httpPort: 0,
    persistenceBackend: 'json',
    sqlitePath: join(tempDir, 'issuecommand.db'),
    sqliteBusyTimeoutMs: 5000,
    sqliteJournalMode: 'WAL',
    migrateJsonToSqlite: false,
    webhookDedupeMaxEntries: 20000,
    webhookEnabled: true,
    webhookPath: '/api/webhooks/github',
    githubWebhookSecret: options.webhookSecret ?? 'webhook-test-secret',
    trustProxy: options.trustProxy ?? false,
    claimTimeoutMinutes: 120,
    staleAutoReleaseMinutes: 0,
    followupStaleMinutes: 1440,
    followupMaxEntries: 1000,
    historyMaxEntries: 1000,
    stateFilePath: join(tempDir, 'state.json'),
    followupStateFilePath: join(tempDir, 'followups-state.json'),
    syncIntervalMinutes: 60,
    allowedRepos: new Set<string>(),
    logFile: undefined,
    apiKey,
    autoCloseGithubIssue: false,
    rateLimit: {
      enabled: true,
      ipPerMinute: 120,
      ipBurst: 40,
      agentMutationsPerMinute: 40,
      agentMutationsBurst: 20,
      sseConnectPerMinute: 10,
      sseConnectBurst: 10,
      ...(options.rateLimit ?? {}),
    },
  };

  const sync = new SyncService({
    claims,
    github,
    logger,
    intervalMinutes: config.syncIntervalMinutes,
    allowedRepos: config.allowedRepos,
  });

  const webhooks = new GitHubWebhookConnector({
    apiKey,
    webhookSecret: config.githubWebhookSecret,
    followups,
    logger,
  });

  const server = startHttpServer({
    service,
    claims,
    followups,
    sync,
    webhooks,
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

function authorizedHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

function signWebhookPayload(secret: string, payload: string): string {
  const digest = createHmac('sha256', secret).update(payload).digest('hex');
  return `sha256=${digest}`;
}
