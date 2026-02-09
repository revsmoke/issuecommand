import { spawn } from 'node:child_process';
import { Logger } from './logger';
import { GitHubIssue, ListIssueOptions, RepoSummary, parseRepo } from './types';

interface GitHubServiceOptions {
  token: string;
  logger: Logger;
  allowedRepos: Set<string>;
  execCommandFn?: ExecCommandFn;
}

export interface GitHubClient {
  listRepos(options?: { includeCounts?: boolean }): Promise<RepoSummary[]>;
  listOpenIssues(repo: string, options?: ListIssueOptions): Promise<GitHubIssue[]>;
  getIssueDetails(repo: string, issueNumber: number): Promise<GitHubIssue>;
  closeIssue(repo: string, issueNumber: number): Promise<boolean>;
}

export interface GhAvailabilityResult {
  available: boolean;
  version?: string;
  reason?: string;
}

type ExecCommandFn = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ code: number; stdout: string; stderr: string }>;

interface RestRepo {
  full_name: string;
  name: string;
  private: boolean;
  description: string | null;
  html_url: string;
  owner: {
    login: string;
  };
  open_issues_count: number;
}

interface RestIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  milestone: { title: string } | null;
  comments_url: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request?: unknown;
}

interface RestIssueComment {
  body: string | null;
  created_at: string;
  html_url: string;
  user: {
    login: string;
  };
}

const GH_ISSUE_LIST_LIMIT = 200;
const REST_PAGE_SIZE = 100;

export class GitHubService implements GitHubClient {
  private readonly token: string;
  private readonly logger: Logger;
  private readonly allowedRepos: Set<string>;
  private readonly execCommandFn: ExecCommandFn;

  constructor(options: GitHubServiceOptions) {
    this.token = options.token;
    this.logger = options.logger;
    this.allowedRepos = options.allowedRepos;
    this.execCommandFn = options.execCommandFn ?? execCommand;
  }

  async checkGhAvailability(): Promise<GhAvailabilityResult> {
    try {
      const { code, stdout, stderr } = await this.execCommandFn('gh', ['--version'], this.buildGhEnv());
      if (code !== 0) {
        return {
          available: false,
          reason: (stderr || stdout || `gh exited with code ${code}`).trim(),
        };
      }

      const version = stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0);

      return {
        available: true,
        version,
      };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listRepos(options: { includeCounts?: boolean } = {}): Promise<RepoSummary[]> {
    const includeCounts = options.includeCounts ?? true;
    const repos = await this.listReposViaRest();
    const filteredRepos = repos
      .filter((repo) => this.isRepoAllowed(repo.full_name))
      .map((repo) => ({
        full_name: repo.full_name,
        owner: repo.owner.login,
        name: repo.name,
        url: repo.html_url,
        description: repo.description ?? undefined,
        private: repo.private,
        open_issue_count: repo.open_issues_count,
      }));

    if (!includeCounts) {
      return filteredRepos.sort((left, right) => left.full_name.localeCompare(right.full_name));
    }

    const withCounts = await Promise.all(
      filteredRepos.map(async (repo) => {
        try {
          const count = await this.countOpenIssues(repo.full_name);
          return {
            ...repo,
            open_issue_count: count,
          };
        } catch (error) {
          this.logger.warn('github.count_open_issues_failed', {
            repo: repo.full_name,
            message: error instanceof Error ? error.message : String(error),
          });
          return repo;
        }
      }),
    );

    return withCounts.sort((left, right) => left.full_name.localeCompare(right.full_name));
  }

  async listOpenIssues(repo: string, options: ListIssueOptions = {}): Promise<GitHubIssue[]> {
    this.assertRepoAllowed(repo);

    try {
      const issues = await this.listOpenIssuesViaGh(repo, options);
      if (issues.length >= GH_ISSUE_LIST_LIMIT) {
        this.logger.warn('github.gh_issue_list_hit_limit_falling_back_to_rest', {
          repo,
          issue_count: issues.length,
          limit: GH_ISSUE_LIST_LIMIT,
        });
        return this.listOpenIssuesViaRest(repo, options);
      }
      return issues;
    } catch (error) {
      this.logger.warn('github.gh_issue_list_failed_falling_back_to_rest', {
        repo,
        message: error instanceof Error ? error.message : String(error),
      });
      return this.listOpenIssuesViaRest(repo, options);
    }
  }

  async getIssueDetails(repo: string, issueNumber: number): Promise<GitHubIssue> {
    this.assertRepoAllowed(repo);

    try {
      return await this.getIssueDetailsViaGh(repo, issueNumber);
    } catch (error) {
      this.logger.warn('github.gh_issue_view_failed_falling_back_to_rest', {
        repo,
        issue_number: issueNumber,
        message: error instanceof Error ? error.message : String(error),
      });
      return this.getIssueDetailsViaRest(repo, issueNumber);
    }
  }

  async closeIssue(repo: string, issueNumber: number): Promise<boolean> {
    this.assertRepoAllowed(repo);

    const { owner, name } = parseRepo(repo);
    await this.rest(`/repos/${owner}/${name}/issues/${issueNumber}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    });

    return true;
  }

  private async listReposViaRest(): Promise<RestRepo[]> {
    const repos: RestRepo[] = [];
    let page = 1;

    while (true) {
      const batch = await this.rest<RestRepo[]>(
        `/user/repos?affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100&page=${page}`,
      );
      if (batch.length === 0) {
        break;
      }

      repos.push(...batch);
      page += 1;
    }

    return repos;
  }

  private async listOpenIssuesViaGh(repo: string, options: ListIssueOptions): Promise<GitHubIssue[]> {
    const args = [
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--limit',
      String(GH_ISSUE_LIST_LIMIT),
      '--json',
      'number,title,body,labels,assignees,milestone,createdAt,updatedAt,url',
    ];

    if (options.label) {
      args.push('--label', options.label);
    }

    if (options.milestone) {
      args.push('--milestone', options.milestone);
    }

    const output = await this.execGhJson<Array<Record<string, unknown>>>(args);

    return output.map((item) => ({
      repo,
      number: Number(item.number),
      title: String(item.title ?? ''),
      body: String(item.body ?? ''),
      state: 'open',
      labels: Array.isArray(item.labels)
        ? item.labels
            .map((label) => (label && typeof label === 'object' ? String((label as { name?: string }).name ?? '') : ''))
            .filter(Boolean)
        : [],
      assignees: Array.isArray(item.assignees)
        ? item.assignees
            .map((assignee) =>
              assignee && typeof assignee === 'object'
                ? String((assignee as { login?: string }).login ?? '')
                : '',
            )
            .filter(Boolean)
        : [],
      milestone:
        item.milestone && typeof item.milestone === 'object'
          ? String((item.milestone as { title?: string }).title ?? '') || undefined
          : undefined,
      comments: [],
      created_at: String(item.createdAt ?? ''),
      updated_at: String(item.updatedAt ?? ''),
      url: String(item.url ?? ''),
    }));
  }

  private async listOpenIssuesViaRest(repo: string, options: ListIssueOptions): Promise<GitHubIssue[]> {
    const { owner, name } = parseRepo(repo);
    const issues: GitHubIssue[] = [];
    let page = 1;

    while (true) {
      const query = new URLSearchParams({
        state: 'open',
        per_page: String(REST_PAGE_SIZE),
        page: String(page),
      });

      if (options.label) {
        query.set('labels', options.label);
      }

      if (options.milestone) {
        query.set('milestone', options.milestone);
      }

      const batch = await this.rest<RestIssue[]>(`/repos/${owner}/${name}/issues?${query.toString()}`);
      const normalized = batch
        .filter((issue) => !issue.pull_request)
        .map((issue) => this.mapRestIssue(repo, issue));

      issues.push(...normalized);

      if (batch.length < REST_PAGE_SIZE) {
        break;
      }

      page += 1;
    }

    return issues;
  }

  private async getIssueDetailsViaGh(repo: string, issueNumber: number): Promise<GitHubIssue> {
    const output = await this.execGhJson<Record<string, unknown>>([
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      repo,
      '--comments',
      '--json',
      'number,title,body,state,labels,assignees,milestone,createdAt,updatedAt,url,comments',
    ]);

    return {
      repo,
      number: Number(output.number),
      title: String(output.title ?? ''),
      body: String(output.body ?? ''),
      state: String(output.state ?? 'open').toLowerCase() === 'closed' ? 'closed' : 'open',
      labels: Array.isArray(output.labels)
        ? output.labels
            .map((label) => (label && typeof label === 'object' ? String((label as { name?: string }).name ?? '') : ''))
            .filter(Boolean)
        : [],
      assignees: Array.isArray(output.assignees)
        ? output.assignees
            .map((assignee) =>
              assignee && typeof assignee === 'object'
                ? String((assignee as { login?: string }).login ?? '')
                : '',
            )
            .filter(Boolean)
        : [],
      milestone:
        output.milestone && typeof output.milestone === 'object'
          ? String((output.milestone as { title?: string }).title ?? '') || undefined
          : undefined,
      comments: Array.isArray(output.comments)
        ? output.comments.map((comment) => ({
            author:
              comment && typeof comment === 'object' && (comment as { author?: { login?: string } }).author
                ? String((comment as { author: { login?: string } }).author.login ?? '')
                : 'unknown',
            body: comment && typeof comment === 'object' ? String((comment as { body?: string }).body ?? '') : '',
            created_at:
              comment && typeof comment === 'object'
                ? String((comment as { createdAt?: string }).createdAt ?? '')
                : '',
            url: comment && typeof comment === 'object' ? String((comment as { url?: string }).url ?? '') : undefined,
          }))
        : [],
      created_at: String(output.createdAt ?? ''),
      updated_at: String(output.updatedAt ?? ''),
      url: String(output.url ?? ''),
    };
  }

  private async getIssueDetailsViaRest(repo: string, issueNumber: number): Promise<GitHubIssue> {
    const { owner, name } = parseRepo(repo);
    const issue = await this.rest<RestIssue>(`/repos/${owner}/${name}/issues/${issueNumber}`);

    const comments: RestIssueComment[] = [];
    let page = 1;

    while (true) {
      const batch = await this.rest<RestIssueComment[]>(
        `/repos/${owner}/${name}/issues/${issueNumber}/comments?per_page=${REST_PAGE_SIZE}&page=${page}`,
      );
      comments.push(...batch);

      if (batch.length < REST_PAGE_SIZE) {
        break;
      }

      page += 1;
    }

    return {
      ...this.mapRestIssue(repo, issue),
      comments: comments.map((comment) => ({
        author: comment.user.login,
        body: comment.body ?? '',
        created_at: comment.created_at,
        url: comment.html_url,
      })),
    };
  }

  private mapRestIssue(repo: string, issue: RestIssue): GitHubIssue {
    return {
      repo,
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      state: issue.state,
      labels: issue.labels.map((label) => label.name),
      assignees: issue.assignees.map((assignee) => assignee.login),
      milestone: issue.milestone?.title ?? undefined,
      comments: [],
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      url: issue.html_url,
    };
  }

  private async countOpenIssues(repo: string): Promise<number> {
    const q = encodeURIComponent(`repo:${repo} type:issue state:open`);
    const response = await this.rest<{ total_count: number }>(`/search/issues?q=${q}&per_page=1`);
    return response.total_count;
  }

  private async rest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'issuecommand/0.1.0',
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub REST request failed (${response.status}): ${body}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async execGhJson<T>(args: string[]): Promise<T> {
    const { code, stdout, stderr } = await this.execCommandFn('gh', args, this.buildGhEnv());

    if (code !== 0) {
      throw new Error(`gh command failed: gh ${args.join(' ')} :: ${stderr}`);
    }

    if (!stdout.trim()) {
      return null as T;
    }

    return JSON.parse(stdout) as T;
  }

  private buildGhEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GH_TOKEN: this.token,
      GITHUB_TOKEN: this.token,
    };
  }

  private isRepoAllowed(repo: string): boolean {
    return this.allowedRepos.size === 0 || this.allowedRepos.has(repo);
  }

  private assertRepoAllowed(repo: string): void {
    if (this.isRepoAllowed(repo)) {
      return;
    }

    throw new Error(`Repository ${repo} is not allowed by ALLOWED_REPOS`);
  }
}

async function execCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}
