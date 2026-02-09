import { ClaimManager } from './claim-manager';
import { FollowupManager } from './followup-manager';
import { GitHubClient } from './github';
import { Logger } from './logger';
import {
  ClaimFilters,
  ClaimOperationResult,
  ClaimRecord,
  FollowupFilters,
  FollowupOperationResult,
  FollowupStatus,
  GitHubIssue,
  HistoryPage,
  ListIssueOptions,
  MyWorkResponse,
  NextWorkResult,
  PrFollowupRecord,
  RepoSummary,
  SystemHealth,
} from './types';

interface IssueCommandServiceOptions {
  claims: ClaimManager;
  followups?: FollowupManager;
  github: GitHubClient;
  logger: Logger;
  autoCloseGithubIssue: boolean;
}

interface NextIssueRequest extends ListIssueOptions {
  agent_id: string;
  repo?: string;
}

export class IssueCommandService {
  private readonly claims: ClaimManager;
  private readonly followups?: FollowupManager;
  private readonly github: GitHubClient;
  private readonly logger: Logger;
  private readonly autoCloseGithubIssue: boolean;

  constructor(options: IssueCommandServiceOptions) {
    this.claims = options.claims;
    this.followups = options.followups;
    this.github = options.github;
    this.logger = options.logger;
    this.autoCloseGithubIssue = options.autoCloseGithubIssue;
  }

  async listRepos(options: { include_counts?: boolean } = {}): Promise<{ repos: RepoSummary[] }> {
    const repos = await this.github.listRepos({ includeCounts: options.include_counts ?? true });
    return { repos };
  }

  async listOpenIssues(input: { repo: string; label?: string; milestone?: string }): Promise<{ issues: GitHubIssue[] }> {
    const issues = await this.github.listOpenIssues(input.repo, {
      label: input.label,
      milestone: input.milestone,
    });

    const unclaimed = issues.filter((issue) => !this.claims.isIssueClaimed(issue.repo, issue.number));
    return {
      issues: unclaimed,
    };
  }

  async getIssueDetails(input: { repo: string; issue_number: number }): Promise<{ issue: GitHubIssue }> {
    const issue = await this.github.getIssueDetails(input.repo, input.issue_number);
    return { issue };
  }

  async claimIssue(input: {
    agent_id: string;
    repo: string;
    issue_number: number;
  }): Promise<ClaimOperationResult> {
    const issue = await this.github.getIssueDetails(input.repo, input.issue_number);

    if (issue.state !== 'open') {
      return {
        ok: false,
        reason: 'invalid_issue',
        message: `Issue ${input.repo}#${input.issue_number} is not open`,
      };
    }

    return this.claims.claimIssue({
      agent_id: input.agent_id,
      repo: input.repo,
      issue_number: input.issue_number,
      issue_title: issue.title,
      issue_labels: issue.labels,
      issue_assignees: issue.assignees,
    });
  }

  async nextIssue(input: NextIssueRequest): Promise<
    ClaimOperationResult & {
      issue?: GitHubIssue;
    }
  > {
    const candidates = await this.collectCandidates(input);

    if (candidates.length === 0) {
      return {
        ok: false,
        reason: 'invalid_issue',
        message: 'No eligible unclaimed issues found',
      };
    }

    const sortedCandidates = candidates.sort(compareIssuesByPriority);

    for (const issue of sortedCandidates) {
      const result = await this.claims.claimIssue({
        agent_id: input.agent_id,
        repo: issue.repo,
        issue_number: issue.number,
        issue_title: issue.title,
        issue_labels: issue.labels,
        issue_assignees: issue.assignees,
      });

      if (result.ok) {
        return {
          ...result,
          issue,
        };
      }

      if (result.reason === 'already_claimed') {
        continue;
      }

      return result;
    }

    return {
      ok: false,
      reason: 'already_claimed',
      message: 'All candidate issues were claimed concurrently',
    };
  }

  async nextWork(input: NextIssueRequest): Promise<NextWorkResult> {
    if (this.followups) {
      const followupResult = await this.followups.claimNextFollowup(input.agent_id, input.repo);
      if (followupResult.ok && followupResult.work_item) {
        return {
          ok: true,
          kind: 'pr_followup',
          work_item: followupResult.work_item,
        };
      }

      if (!followupResult.ok && followupResult.reason !== 'no_followup_available') {
        return {
          ok: false,
          reason: followupResult.reason,
          message: followupResult.message,
        };
      }
    }

    const nextIssue = await this.nextIssue(input);
    if (!nextIssue.ok || !nextIssue.claim || !nextIssue.issue) {
      return {
        ok: false,
        reason: nextIssue.reason,
        message: nextIssue.message,
      };
    }

    return {
      ok: true,
      kind: 'issue',
      claim: nextIssue.claim,
      issue: nextIssue.issue,
    };
  }

  async releaseIssue(input: {
    claim_id: string;
    agent_id: string;
    reason?: string;
  }): Promise<ClaimOperationResult> {
    return this.claims.releaseIssue({
      claim_id: input.claim_id,
      agent_id: input.agent_id,
      reason: input.reason,
      source: 'agent',
    });
  }

  async updateClaimStatus(input: {
    claim_id: string;
    agent_id: string;
    status: ClaimRecord['status'];
    note?: string;
    pr_url?: string;
  }): Promise<ClaimOperationResult & { issue_closed?: boolean; issue_close_error?: string }> {
    const result = await this.claims.updateClaimStatus({
      claim_id: input.claim_id,
      agent_id: input.agent_id,
      status: input.status,
      note: input.note,
      pr_url: input.pr_url,
      source: 'agent',
    });

    if (!result.ok || !result.claim || result.claim.status !== 'closed') {
      return result;
    }

    if (!this.autoCloseGithubIssue) {
      return {
        ...result,
        issue_closed: false,
      };
    }

    try {
      await this.github.closeIssue(result.claim.repo, result.claim.issue_number);
      this.logger.info('github.issue_closed', {
        claim_id: result.claim.claim_id,
        repo: result.claim.repo,
        issue_number: result.claim.issue_number,
      });

      return {
        ...result,
        issue_closed: true,
      };
    } catch (error) {
      this.logger.error('github.issue_close_failed', {
        claim_id: result.claim.claim_id,
        repo: result.claim.repo,
        issue_number: result.claim.issue_number,
        message: error instanceof Error ? error.message : String(error),
      });

      return {
        ...result,
        issue_closed: false,
        issue_close_error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getClaims(filters: ClaimFilters = {}): { claims: ClaimRecord[] } {
    return {
      claims: this.claims.getActiveClaims(filters),
    };
  }

  getFollowups(filters: FollowupFilters = {}): { followups: PrFollowupRecord[] } {
    return {
      followups: this.followups ? this.followups.listFollowups(filters) : [],
    };
  }

  async updateFollowupStatus(input: {
    work_item_id: string;
    status: FollowupStatus;
    note?: string;
    agent_id: string;
  }): Promise<FollowupOperationResult> {
    if (!this.followups) {
      return {
        ok: false,
        reason: 'unknown',
        message: 'PR follow-up workflow is not configured',
      };
    }

    return this.followups.updateFollowupStatus({
      ...input,
      source: 'agent',
    });
  }

  getMyWork(input: { agent_id: string }): { work: MyWorkResponse } {
    return {
      work: {
        claims: this.claims.getActiveClaims({ agent_id: input.agent_id }),
        followups: this.followups ? this.followups.getMyFollowups(input.agent_id) : [],
      },
    };
  }

  getClaimHistory(input: {
    repo?: string;
    agent_id?: string;
    limit?: number;
    cursor?: string;
  } = {}): HistoryPage {
    return this.claims.getHistory(input.limit ?? 50, input.cursor, {
      repo: input.repo,
      agent_id: input.agent_id,
    });
  }

  systemHealth(): { health: SystemHealth } {
    return {
      health: this.claims.getSystemHealth(),
    };
  }

  private async collectCandidates(input: NextIssueRequest): Promise<GitHubIssue[]> {
    if (input.repo) {
      const issues = await this.github.listOpenIssues(input.repo, {
        label: input.label,
        milestone: input.milestone,
      });
      return issues.filter((issue) => !this.claims.isIssueClaimed(issue.repo, issue.number));
    }

    const repos = await this.github.listRepos({ includeCounts: false });
    const allIssues = await Promise.all(
      repos.map((repo) =>
        this.github.listOpenIssues(repo.full_name, {
          label: input.label,
          milestone: input.milestone,
        }),
      ),
    );

    return allIssues
      .flat()
      .filter((issue) => !this.claims.isIssueClaimed(issue.repo, issue.number));
  }
}

function compareIssuesByPriority(left: GitHubIssue, right: GitHubIssue): number {
  const priorityDiff = scoreIssuePriority(left.labels) - scoreIssuePriority(right.labels);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  return Date.parse(left.created_at) - Date.parse(right.created_at);
}

function scoreIssuePriority(labels: string[]): number {
  const normalized = labels.map((label) => label.trim().toLowerCase());

  if (
    normalized.some((label) =>
      ['p0', 'priority:critical', 'priority/high', 'high', 'severity:critical', 'sev:1'].includes(label),
    )
  ) {
    return 0;
  }

  if (
    normalized.some((label) => ['p1', 'priority:high', 'priority/medium', 'medium', 'sev:2'].includes(label))
  ) {
    return 1;
  }

  return 2;
}
