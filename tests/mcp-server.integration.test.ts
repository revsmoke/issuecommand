import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ClaimManager } from '../src/claim-manager';
import { FollowupManager } from '../src/followup-manager';
import { IssueCommandService } from '../src/issuecommand-service';
import { Logger } from '../src/logger';
import { createMcpServer } from '../src/mcp-server';
import { StatePersistence } from '../src/state-persistence';
import type { FollowupPersistedState } from '../src/types';
import { buildIssue, FakeGitHubClient } from './test-helpers';

interface McpTestContext {
  tempDir: string;
  client: Client;
  followups: FollowupManager;
  close: () => Promise<void>;
}

const contexts: McpTestContext[] = [];

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop();
    if (!context) {
      continue;
    }

    await context.close();
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

describe('MCP server integration', () => {
  test('exposes tools and supports next_issue claim flow', async () => {
    const context = await createMcpTestContext();

    const listTools = await context.client.listTools();
    const toolNames = new Set(listTools.tools.map((tool) => tool.name));

    expect(toolNames.has('next_issue')).toBeTrue();
    expect(toolNames.has('claim_issue')).toBeTrue();

    const nextIssueResult = await context.client.callTool({
      name: 'next_issue',
      arguments: {
        agent_id: 'agent-1',
        repo: 'acme/api',
      },
    });

    const nextIssuePayload = parseToolPayload(nextIssueResult);
    expect(nextIssuePayload.ok).toBeTrue();
    expect(nextIssuePayload.issue.number).toBe(1);

    const listOpenIssuesResult = await context.client.callTool({
      name: 'list_open_issues',
      arguments: {
        repo: 'acme/api',
      },
    });

    const openIssuesPayload = parseToolPayload(listOpenIssuesResult);
    expect(openIssuesPayload.issues.map((issue: { number: number }) => issue.number)).toEqual([2]);
  });

  test('supports followup workflow tools', async () => {
    const context = await createMcpTestContext();

    const createFollowup = await context.followups.createFromWebhook({
      repo: 'acme/api',
      pr_number: 301,
      pr_url: 'https://github.com/acme/api/pull/301',
      pr_title: 'Fix review notes',
      source_event_type: 'review_comment',
      source_event_id: 'review_comment:301',
      summary: 'Please fix review note',
      actionable_comments: ['Please fix review note'],
    });
    expect(createFollowup.ok).toBeTrue();

    const nextWorkResult = await context.client.callTool({
      name: 'next_work',
      arguments: {
        agent_id: 'agent-followup',
        repo: 'acme/api',
      },
    });
    const nextWorkPayload = parseToolPayload(nextWorkResult);
    expect(nextWorkPayload.ok).toBeTrue();
    expect(nextWorkPayload.kind).toBe('pr_followup');

    const workItemId = nextWorkPayload.work_item?.work_item_id as string;
    expect(workItemId).toBeTruthy();

    const myWorkResult = await context.client.callTool({
      name: 'get_my_work',
      arguments: {
        agent_id: 'agent-followup',
      },
    });
    const myWorkPayload = parseToolPayload(myWorkResult);
    expect(myWorkPayload.work.followups.length).toBe(1);

    const updateFollowupResult = await context.client.callTool({
      name: 'update_followup_status',
      arguments: {
        work_item_id: workItemId,
        agent_id: 'agent-followup',
        status: 'done',
      },
    });
    const updatePayload = parseToolPayload(updateFollowupResult);
    expect(updatePayload.ok).toBeTrue();
    expect(updatePayload.work_item.status).toBe('done');

    const followupsResult = await context.client.callTool({
      name: 'get_followups',
      arguments: {
        repo: 'acme/api',
      },
    });
    const followupsPayload = parseToolPayload(followupsResult);
    expect(followupsPayload.followups.length).toBe(0);
  });

  test('enforces claim ownership on release and status update tools', async () => {
    const context = await createMcpTestContext();

    const nextIssueResult = await context.client.callTool({
      name: 'next_issue',
      arguments: {
        agent_id: 'agent-owner',
        repo: 'acme/api',
      },
    });
    const nextIssuePayload = parseToolPayload(nextIssueResult);
    expect(nextIssuePayload.ok).toBeTrue();

    const claimId = nextIssuePayload.claim?.claim_id as string;
    expect(claimId).toBeTruthy();

    const mismatchUpdate = await context.client.callTool({
      name: 'update_claim_status',
      arguments: {
        claim_id: claimId,
        agent_id: 'agent-other',
        status: 'in_progress',
      },
    });
    const mismatchUpdatePayload = parseToolPayload(mismatchUpdate);
    expect(mismatchUpdatePayload.ok).toBeFalse();
    expect(mismatchUpdatePayload.reason).toBe('agent_mismatch');

    const mismatchRelease = await context.client.callTool({
      name: 'release_issue',
      arguments: {
        claim_id: claimId,
        agent_id: 'agent-other',
      },
    });
    const mismatchReleasePayload = parseToolPayload(mismatchRelease);
    expect(mismatchReleasePayload.ok).toBeFalse();
    expect(mismatchReleasePayload.reason).toBe('agent_mismatch');

    const ownerUpdate = await context.client.callTool({
      name: 'update_claim_status',
      arguments: {
        claim_id: claimId,
        agent_id: 'agent-owner',
        status: 'in_progress',
      },
    });
    const ownerUpdatePayload = parseToolPayload(ownerUpdate);
    expect(ownerUpdatePayload.ok).toBeTrue();
    expect(ownerUpdatePayload.claim.status).toBe('in_progress');

    const ownerRelease = await context.client.callTool({
      name: 'release_issue',
      arguments: {
        claim_id: claimId,
        agent_id: 'agent-owner',
      },
    });
    const ownerReleasePayload = parseToolPayload(ownerRelease);
    expect(ownerReleasePayload.ok).toBeTrue();
    expect(ownerReleasePayload.claim.status).toBe('released');
  });

  test('rejects missing required agent_id in claim mutation tools', async () => {
    const context = await createMcpTestContext();
    const nextIssueResult = await context.client.callTool({
      name: 'next_issue',
      arguments: {
        agent_id: 'agent-owner',
        repo: 'acme/api',
      },
    });
    const nextIssuePayload = parseToolPayload(nextIssueResult);
    expect(nextIssuePayload.ok).toBeTrue();
    const claimId = nextIssuePayload.claim?.claim_id as string;
    expect(claimId).toBeTruthy();

    const releaseWithoutAgent = await context.client.callTool({
      name: 'release_issue',
      arguments: {
        claim_id: claimId,
      },
    });
    const releaseWithoutAgentText = getToolText(releaseWithoutAgent);
    expect(releaseWithoutAgentText.toLowerCase()).toContain('agent_id');

    const updateWithoutAgent = await context.client.callTool({
      name: 'update_claim_status',
      arguments: {
        claim_id: claimId,
        status: 'in_progress',
      },
    });
    const updateWithoutAgentText = getToolText(updateWithoutAgent);
    expect(updateWithoutAgentText.toLowerCase()).toContain('agent_id');
  });
});

async function createMcpTestContext(): Promise<McpTestContext> {
  const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-mcp-'));
  const logger = new Logger({ silent: true });
  const claimPersistence = new StatePersistence({
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
    persistence: claimPersistence,
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
    issues: [
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

  const server = createMcpServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client(
    {
      name: 'issuecommand-test-client',
      version: '0.1.0',
    },
    {
      capabilities: {},
    },
  );

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const context: McpTestContext = {
    tempDir,
    client,
    followups,
    close: async () => {
      await client.close();
      await server.close();
    },
  };

  contexts.push(context);

  return context;
}

function parseToolPayload(result: Record<string, unknown>): Record<string, any> {
  const text = getToolText(result);
  return JSON.parse(text) as Record<string, any>;
}

function getToolText(result: Record<string, unknown>): string {
  if (!('content' in result) || !Array.isArray(result.content)) {
    throw new Error('Tool response did not contain structured content blocks');
  }

  const content = result.content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((item) => item.type === 'text');
  if (!textBlock || typeof textBlock.text !== 'string') {
    throw new Error('Tool response did not contain a text block');
  }

  return textBlock.text;
}
