import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { Logger } from './logger';
import { ClaimStatus, FollowupStatus } from './types';
import { IssueCommandService } from './issuecommand-service';

interface McpServerOptions {
  service: IssueCommandService;
  logger: Logger;
}

interface RunningMcpServer {
  close: () => Promise<void>;
}

const STATUS_SCHEMA = z.enum([
  'claimed',
  'in_progress',
  'pr_submitted',
  'pr_merged',
  'closed',
  'released',
  'stale',
]);

const FOLLOWUP_STATUS_SCHEMA = z.enum([
  'queued',
  'claimed',
  'in_progress',
  'done',
  'dismissed',
  'stale',
]);

export async function startMcpServer(options: McpServerOptions): Promise<RunningMcpServer> {
  const server = createMcpServer(options.service);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  options.logger.info('mcp.started');

  return {
    close: () => server.close(),
  };
}

export function createMcpServer(service: IssueCommandService): McpServer {
  const server = new McpServer({
    name: 'issuecommand',
    version: '0.1.0',
  });

  registerTools(server, service);
  return server;
}

function registerTools(server: McpServer, service: IssueCommandService): void {
  server.registerTool(
    'list_repos',
    {
      description: 'List accessible repositories with open issue counts.',
      inputSchema: {
        include_counts: z.boolean().optional(),
      },
    },
    async ({ include_counts }) => {
      return asToolResult(await service.listRepos({ include_counts }));
    },
  );

  server.registerTool(
    'list_open_issues',
    {
      description: 'List open unclaimed issues for a repository.',
      inputSchema: {
        repo: z.string().describe('owner/repo'),
        label: z.string().optional(),
        milestone: z.string().optional(),
      },
    },
    async ({ repo, label, milestone }) => {
      return asToolResult(await service.listOpenIssues({ repo, label, milestone }));
    },
  );

  server.registerTool(
    'get_issue_details',
    {
      description: 'Get full issue details including comments and metadata.',
      inputSchema: {
        repo: z.string().describe('owner/repo'),
        issue_number: z.number().int().positive(),
      },
    },
    async ({ repo, issue_number }) => {
      return asToolResult(await service.getIssueDetails({ repo, issue_number }));
    },
  );

  server.registerTool(
    'next_issue',
    {
      description: 'Find the highest-priority unclaimed issue and immediately claim it.',
      inputSchema: {
        agent_id: z.string(),
        repo: z.string().optional(),
        label: z.string().optional(),
        milestone: z.string().optional(),
      },
    },
    async ({ agent_id, repo, label, milestone }) => {
      return asToolResult(await service.nextIssue({ agent_id, repo, label, milestone }));
    },
  );

  server.registerTool(
    'next_work',
    {
      description:
        'Claim next available work item for an agent, prioritizing PR follow-up tasks before new issues.',
      inputSchema: {
        agent_id: z.string(),
        repo: z.string().optional(),
        label: z.string().optional(),
        milestone: z.string().optional(),
      },
    },
    async ({ agent_id, repo, label, milestone }) => {
      return asToolResult(await service.nextWork({ agent_id, repo, label, milestone }));
    },
  );

  server.registerTool(
    'claim_issue',
    {
      description: 'Claim an issue for an agent.',
      inputSchema: {
        agent_id: z.string(),
        repo: z.string().describe('owner/repo'),
        issue_number: z.number().int().positive(),
      },
    },
    async ({ agent_id, repo, issue_number }) => {
      return asToolResult(await service.claimIssue({ agent_id, repo, issue_number }));
    },
  );

  server.registerTool(
    'release_issue',
    {
      description: 'Release a claim.',
      inputSchema: {
        claim_id: z.string(),
        agent_id: z.string(),
        reason: z.string().optional(),
      },
    },
    async ({ claim_id, agent_id, reason }) => {
      return asToolResult(await service.releaseIssue({ claim_id, agent_id, reason }));
    },
  );

  server.registerTool(
    'update_claim_status',
    {
      description: 'Update claim status in the workflow lifecycle.',
      inputSchema: {
        claim_id: z.string(),
        agent_id: z.string(),
        status: STATUS_SCHEMA,
        note: z.string().optional(),
        pr_url: z.string().optional(),
      },
    },
    async ({ claim_id, agent_id, status, note, pr_url }) => {
      return asToolResult(
        await service.updateClaimStatus({
          claim_id,
          agent_id,
          status: status as ClaimStatus,
          note,
          pr_url,
        }),
      );
    },
  );

  server.registerTool(
    'get_followups',
    {
      description: 'Get active PR follow-up work items with optional filters.',
      inputSchema: {
        repo: z.string().optional(),
        status: FOLLOWUP_STATUS_SCHEMA.optional(),
        claimed_by_agent_id: z.string().optional(),
        pr_number: z.number().int().positive().optional(),
      },
    },
    async ({ repo, status, claimed_by_agent_id, pr_number }) => {
      return asToolResult(
        service.getFollowups({
          repo,
          status: status as FollowupStatus | undefined,
          claimed_by_agent_id,
          pr_number,
        }),
      );
    },
  );

  server.registerTool(
    'update_followup_status',
    {
      description: 'Update PR follow-up status for an assigned agent work item.',
      inputSchema: {
        work_item_id: z.string(),
        agent_id: z.string(),
        status: FOLLOWUP_STATUS_SCHEMA,
        note: z.string().optional(),
      },
    },
    async ({ work_item_id, agent_id, status, note }) => {
      return asToolResult(
        await service.updateFollowupStatus({
          work_item_id,
          agent_id,
          status: status as FollowupStatus,
          note,
        }),
      );
    },
  );

  server.registerTool(
    'get_my_claims',
    {
      description: 'Get active claims for a specific agent.',
      inputSchema: {
        agent_id: z.string(),
      },
    },
    async ({ agent_id }) => {
      return asToolResult(service.getClaims({ agent_id }));
    },
  );

  server.registerTool(
    'get_my_work',
    {
      description: 'Get active claims and PR follow-up items currently assigned to an agent.',
      inputSchema: {
        agent_id: z.string(),
      },
    },
    async ({ agent_id }) => {
      return asToolResult(service.getMyWork({ agent_id }));
    },
  );

  server.registerTool(
    'get_all_claims',
    {
      description: 'Get all active claims with optional filters.',
      inputSchema: {
        agent_id: z.string().optional(),
        repo: z.string().optional(),
        status: STATUS_SCHEMA.optional(),
      },
    },
    async ({ agent_id, repo, status }) => {
      return asToolResult(service.getClaims({ agent_id, repo, status: status as ClaimStatus | undefined }));
    },
  );

  server.registerTool(
    'get_claim_history',
    {
      description: 'Get historical log of completed or released claims.',
      inputSchema: {
        repo: z.string().optional(),
        agent_id: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
        cursor: z.string().optional(),
      },
    },
    async ({ repo, agent_id, limit, cursor }) => {
      return asToolResult(service.getClaimHistory({ repo, agent_id, limit, cursor }));
    },
  );

  server.registerTool(
    'system_health',
    {
      description: 'Get system health metrics and uptime.',
    },
    async () => {
      return asToolResult(service.systemHealth());
    },
  );
}

function asToolResult(payload: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: toStructuredContent(payload),
  };
}

function toStructuredContent(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }

  return {
    value: payload,
  };
}
