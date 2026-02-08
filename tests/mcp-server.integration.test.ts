import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ClaimManager } from '../src/claim-manager';
import { IssueCommandService } from '../src/issuecommand-service';
import { Logger } from '../src/logger';
import { createMcpServer } from '../src/mcp-server';
import { StatePersistence } from '../src/state-persistence';
import { buildIssue, FakeGitHubClient } from './test-helpers';

interface McpTestContext {
  tempDir: string;
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
});

async function createMcpTestContext(): Promise<McpTestContext & { client: Client }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-mcp-'));
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

  const context: McpTestContext & { client: Client } = {
    tempDir,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };

  contexts.push(context);

  return context;
}

function parseToolPayload(result: Record<string, unknown>): Record<string, any> {
  if (!('content' in result) || !Array.isArray(result.content)) {
    throw new Error('Tool response did not contain structured content blocks');
  }

  const content = result.content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((item) => item.type === 'text');
  if (!textBlock || typeof textBlock.text !== 'string') {
    throw new Error('Tool response did not contain a text block');
  }

  return JSON.parse(textBlock.text) as Record<string, any>;
}
