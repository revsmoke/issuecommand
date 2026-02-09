import { afterEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FollowupManager } from '../src/followup-manager';
import { GitHubWebhookConnector } from '../src/github-webhook';
import { Logger } from '../src/logger';
import { StatePersistence } from '../src/state-persistence';
import type { FollowupPersistedState } from '../src/types';

interface WebhookTestContext {
  followups: FollowupManager;
  connector: GitHubWebhookConnector;
  tempDir: string;
}

const contexts: WebhookTestContext[] = [];

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop();
    if (!context) {
      continue;
    }

    await rm(context.tempDir, { recursive: true, force: true });
  }
});

describe('GitHubWebhookConnector', () => {
  test('creates followup from signed pull_request_review event', async () => {
    const context = await createWebhookTestContext({
      secret: 'webhook-test-secret',
      apiKey: 'test-api-key',
    });

    const payload = JSON.stringify({
      action: 'submitted',
      repository: { full_name: 'acme/api' },
      pull_request: {
        number: 321,
        html_url: 'https://github.com/acme/api/pull/321',
        title: 'Improve async orchestration',
      },
      review: {
        id: 1111,
        state: 'changes_requested',
        body: 'Please address the inline comments',
        user: { login: 'reviewer-a' },
      },
    });

    const response = await context.connector.process({
      headers: new Headers({
        'content-type': 'application/json',
        'x-github-event': 'pull_request_review',
        'x-github-delivery': 'delivery-review-1',
        'x-hub-signature-256': sign('webhook-test-secret', payload),
      }),
      rawBody: payload,
    });

    expect(response.ok).toBeTrue();
    expect(response.status).toBe(202);

    const followups = context.followups.listFollowups({
      repo: 'acme/api',
    });
    expect(followups.length).toBe(1);
    expect(followups[0].pr_number).toBe(321);
    expect(followups[0].source_event_type).toBe('review_changes_requested');
  });

  test('rejects webhook requests without valid signature or API key', async () => {
    const context = await createWebhookTestContext({
      secret: 'webhook-test-secret',
      apiKey: 'test-api-key',
    });

    const payload = JSON.stringify({
      action: 'submitted',
      repository: { full_name: 'acme/api' },
      pull_request: { number: 1, html_url: 'https://github.com/acme/api/pull/1', title: 'x' },
      review: { id: 1, state: 'changes_requested', body: 'x', user: { login: 'reviewer' } },
    });

    const response = await context.connector.process({
      headers: new Headers({
        'content-type': 'application/json',
        'x-github-event': 'pull_request_review',
      }),
      rawBody: payload,
    });

    expect(response.ok).toBeFalse();
    expect(response.status).toBe(401);
    expect(context.followups.listFollowups().length).toBe(0);
  });

  test('ignores followup-creation events with missing repo or PR number', async () => {
    const context = await createWebhookTestContext({
      secret: 'webhook-test-secret',
      apiKey: 'test-api-key',
    });

    const payload = JSON.stringify({
      action: 'submitted',
      repository: { full_name: '' },
      pull_request: {
        number: 0,
        html_url: 'https://github.com/acme/api/pull/0',
        title: 'Invalid payload',
      },
      review: {
        id: 42,
        state: 'changes_requested',
        body: 'Needs changes',
        user: { login: 'reviewer' },
      },
    });

    const response = await context.connector.process({
      headers: new Headers({
        'content-type': 'application/json',
        'x-github-event': 'pull_request_review',
        'x-github-delivery': 'delivery-invalid-1',
        'x-hub-signature-256': sign('webhook-test-secret', payload),
      }),
      rawBody: payload,
    });

    expect(response.ok).toBeTrue();
    expect(response.status).toBe(202);
    expect(response.body.ignored).toBeTrue();
    expect(context.followups.listFollowups().length).toBe(0);
  });

  test('pull_request synchronize event marks matching active followups as done', async () => {
    const context = await createWebhookTestContext({
      secret: 'webhook-test-secret',
      apiKey: 'test-api-key',
    });

    const createPayload = JSON.stringify({
      action: 'created',
      repository: { full_name: 'acme/api' },
      issue: {
        number: 55,
        html_url: 'https://github.com/acme/api/pull/55',
        title: 'Address review thread',
        pull_request: {},
      },
      comment: {
        id: 777,
        body: 'Please update this section',
        user: { login: 'reviewer-b' },
      },
    });

    const createResponse = await context.connector.process({
      headers: new Headers({
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'delivery-comment-1',
        'x-hub-signature-256': sign('webhook-test-secret', createPayload),
      }),
      rawBody: createPayload,
    });
    expect(createResponse.ok).toBeTrue();
    expect(context.followups.listFollowups({ repo: 'acme/api' }).length).toBe(1);

    const synchronizePayload = JSON.stringify({
      action: 'synchronize',
      repository: { full_name: 'acme/api' },
      pull_request: {
        number: 55,
      },
    });

    const synchronizeResponse = await context.connector.process({
      headers: new Headers({
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-sync-1',
        'x-hub-signature-256': sign('webhook-test-secret', synchronizePayload),
      }),
      rawBody: synchronizePayload,
    });

    expect(synchronizeResponse.ok).toBeTrue();
    expect(context.followups.listFollowups({ repo: 'acme/api' }).length).toBe(0);

    const history = context.followups.getHistory(10, undefined, { repo: 'acme/api' });
    expect(history.items.length).toBe(1);
    expect(history.items[0].status).toBe('done');
  });

  test('uses external dedupe store to reject duplicate deliveries across connector instances', async () => {
    const context = await createWebhookTestContext({
      secret: 'webhook-test-secret',
      apiKey: 'test-api-key',
    });

    const seenDeliveries = new Set<string>();
    const dedupeStore = {
      markDeliveryIfNew: async (deliveryId: string): Promise<boolean> => {
        if (seenDeliveries.has(deliveryId)) {
          return false;
        }
        seenDeliveries.add(deliveryId);
        return true;
      },
    };

    const firstConnector = new GitHubWebhookConnector({
      apiKey: 'test-api-key',
      webhookSecret: 'webhook-test-secret',
      followups: context.followups,
      logger: new Logger({ silent: true }),
      webhookDedupe: dedupeStore,
    });

    const secondConnector = new GitHubWebhookConnector({
      apiKey: 'test-api-key',
      webhookSecret: 'webhook-test-secret',
      followups: context.followups,
      logger: new Logger({ silent: true }),
      webhookDedupe: dedupeStore,
    });

    const payload = JSON.stringify({
      action: 'created',
      repository: { full_name: 'acme/api' },
      issue: {
        number: 77,
        html_url: 'https://github.com/acme/api/pull/77',
        title: 'Fix review',
        pull_request: {},
      },
      comment: {
        id: 7070,
        body: 'Please update this part',
        user: { login: 'reviewer-c' },
      },
    });

    const first = await firstConnector.process({
      headers: new Headers({
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'delivery-persisted-1',
        'x-hub-signature-256': sign('webhook-test-secret', payload),
      }),
      rawBody: payload,
    });
    expect(first.status).toBe(202);

    const second = await secondConnector.process({
      headers: new Headers({
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'delivery-persisted-1',
        'x-hub-signature-256': sign('webhook-test-secret', payload),
      }),
      rawBody: payload,
    });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBeTrue();

    const followups = context.followups.listFollowups({ repo: 'acme/api' });
    expect(followups.length).toBe(1);
  });
});

async function createWebhookTestContext(input: {
  secret: string;
  apiKey: string;
}): Promise<WebhookTestContext> {
  const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-webhook-'));
  const logger = new Logger({ silent: true });
  const persistence = new StatePersistence<FollowupPersistedState>({
    filePath: join(tempDir, 'followups-state.json'),
    logger,
    debounceMs: 5,
  });

  const followups = new FollowupManager({
    persistence,
    logger,
    maxEntries: 1000,
    staleMinutes: 1440,
  });
  await followups.initialize();

  const connector = new GitHubWebhookConnector({
    apiKey: input.apiKey,
    webhookSecret: input.secret,
    followups,
    logger,
  });

  const context: WebhookTestContext = {
    followups,
    connector,
    tempDir,
  };
  contexts.push(context);
  return context;
}

function sign(secret: string, payload: string): string {
  const digest = createHmac('sha256', secret).update(payload).digest('hex');
  return `sha256=${digest}`;
}
