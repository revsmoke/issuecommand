import { GitHubClient } from '../src/github';
import { GitHubIssue, ListIssueOptions, RepoSummary } from '../src/types';

interface FakeRepoInput {
  full_name: string;
  private?: boolean;
  description?: string;
  url?: string;
}

export class FakeGitHubClient implements GitHubClient {
  private readonly repos = new Map<string, RepoSummary>();
  private readonly issues = new Map<string, GitHubIssue[]>();

  constructor(input: { repos?: FakeRepoInput[]; issues?: GitHubIssue[] } = {}) {
    for (const repo of input.repos ?? []) {
      const [owner, name] = repo.full_name.split('/');
      this.repos.set(repo.full_name, {
        full_name: repo.full_name,
        owner,
        name,
        url: repo.url ?? `https://github.com/${repo.full_name}`,
        description: repo.description,
        private: repo.private ?? false,
        open_issue_count: 0,
      });
    }

    for (const issue of input.issues ?? []) {
      this.seedIssue(issue);
    }
  }

  seedIssue(issue: GitHubIssue): void {
    if (!this.repos.has(issue.repo)) {
      const [owner, name] = issue.repo.split('/');
      this.repos.set(issue.repo, {
        full_name: issue.repo,
        owner,
        name,
        url: `https://github.com/${issue.repo}`,
        private: false,
        open_issue_count: 0,
      });
    }

    const issues = this.issues.get(issue.repo) ?? [];
    const withoutSameNumber = issues.filter((existing) => existing.number !== issue.number);
    withoutSameNumber.push(structuredClone(issue));
    this.issues.set(issue.repo, withoutSameNumber);
  }

  async listRepos(options: { includeCounts?: boolean } = {}): Promise<RepoSummary[]> {
    const includeCounts = options.includeCounts ?? true;

    return [...this.repos.values()]
      .map((repo) => ({
        ...repo,
        open_issue_count: includeCounts
          ? (this.issues.get(repo.full_name) ?? []).filter((issue) => issue.state === 'open').length
          : repo.open_issue_count,
      }))
      .sort((left, right) => left.full_name.localeCompare(right.full_name));
  }

  async listOpenIssues(repo: string, options: ListIssueOptions = {}): Promise<GitHubIssue[]> {
    const issues = (this.issues.get(repo) ?? []).filter((issue) => issue.state === 'open');

    return issues
      .filter((issue) => {
        if (options.label && !issue.labels.includes(options.label)) {
          return false;
        }
        if (options.milestone && issue.milestone !== options.milestone) {
          return false;
        }
        return true;
      })
      .map((issue) => structuredClone(issue));
  }

  async getIssueDetails(repo: string, issueNumber: number): Promise<GitHubIssue> {
    const issue = (this.issues.get(repo) ?? []).find((candidate) => candidate.number === issueNumber);
    if (!issue) {
      throw new Error(`Issue ${repo}#${issueNumber} not found`);
    }

    return structuredClone(issue);
  }

  async closeIssue(repo: string, issueNumber: number): Promise<boolean> {
    const issues = this.issues.get(repo) ?? [];
    const issue = issues.find((candidate) => candidate.number === issueNumber);
    if (!issue) {
      return false;
    }

    issue.state = 'closed';
    issue.updated_at = new Date().toISOString();
    return true;
  }
}

export function buildIssue(input: {
  repo: string;
  number: number;
  title?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: string;
  state?: 'open' | 'closed';
  created_at?: string;
}): GitHubIssue {
  return {
    repo: input.repo,
    number: input.number,
    title: input.title ?? `Issue ${input.number}`,
    body: '',
    state: input.state ?? 'open',
    labels: input.labels ?? [],
    assignees: input.assignees ?? [],
    milestone: input.milestone,
    comments: [],
    created_at: input.created_at ?? new Date('2026-02-01T00:00:00.000Z').toISOString(),
    updated_at: input.created_at ?? new Date('2026-02-01T00:00:00.000Z').toISOString(),
    url: `https://github.com/${input.repo}/issues/${input.number}`,
  };
}
