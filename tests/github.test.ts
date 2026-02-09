import { afterEach, describe, expect, test } from 'bun:test';
import { GitHubService } from '../src/github';
import { Logger } from '../src/logger';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('GitHubService', () => {
  test('returns available with parsed version when gh succeeds', async () => {
    const service = new GitHubService({
      token: 'test-token',
      logger: new Logger({ silent: true }),
      allowedRepos: new Set<string>(),
      execCommandFn: async () => ({
        code: 0,
        stdout: 'gh version 2.58.0 (2026-01-01)\nhttps://github.com/cli/cli/releases/latest',
        stderr: '',
      }),
    });

    const result = await service.checkGhAvailability();

    expect(result.available).toBeTrue();
    expect(result.version).toBe('gh version 2.58.0 (2026-01-01)');
  });

  test('returns unavailable when gh exits with non-zero status', async () => {
    const service = new GitHubService({
      token: 'test-token',
      logger: new Logger({ silent: true }),
      allowedRepos: new Set<string>(),
      execCommandFn: async () => ({
        code: 127,
        stdout: '',
        stderr: 'command not found: gh',
      }),
    });

    const result = await service.checkGhAvailability();

    expect(result.available).toBeFalse();
    expect(result.reason).toContain('command not found');
  });

  test('returns unavailable when command runner throws', async () => {
    const service = new GitHubService({
      token: 'test-token',
      logger: new Logger({ silent: true }),
      allowedRepos: new Set<string>(),
      execCommandFn: async () => {
        throw new Error('spawn failed');
      },
    });

    const result = await service.checkGhAvailability();

    expect(result.available).toBeFalse();
    expect(result.reason).toContain('spawn failed');
  });

  test('listOpenIssues uses gh output when gh succeeds', async () => {
    const commandInvocations: Array<{ command: string; args: string[] }> = [];

    const service = new GitHubService({
      token: 'test-token',
      logger: new Logger({ silent: true }),
      allowedRepos: new Set<string>(),
      execCommandFn: async (command, args) => {
        commandInvocations.push({ command, args });

        if (args[0] === 'issue' && args[1] === 'list') {
          return {
            code: 0,
            stdout: JSON.stringify([
              {
                number: 101,
                title: 'Fix flaky build',
                body: 'Details',
                labels: [{ name: 'P0' }],
                assignees: [{ login: 'dev1' }],
                milestone: { title: 'Q1' },
                createdAt: '2026-02-01T00:00:00.000Z',
                updatedAt: '2026-02-02T00:00:00.000Z',
                url: 'https://github.com/acme/api/issues/101',
              },
            ]),
            stderr: '',
          };
        }

        return {
          code: 1,
          stdout: '',
          stderr: 'unexpected command',
        };
      },
    });

    setMockFetch(async () => {
      throw new Error('fetch should not be called when gh succeeds');
    });

    const issues = await service.listOpenIssues('acme/api', {
      label: 'bug',
      milestone: 'Q1',
    });

    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(101);
    expect(issues[0].labels).toEqual(['P0']);
    expect(issues[0].assignees).toEqual(['dev1']);
    expect(issues[0].milestone).toBe('Q1');

    expect(commandInvocations).toHaveLength(1);
    expect(commandInvocations[0].command).toBe('gh');
    expect(commandInvocations[0].args).toContain('--label');
    expect(commandInvocations[0].args).toContain('bug');
    expect(commandInvocations[0].args).toContain('--milestone');
    expect(commandInvocations[0].args).toContain('Q1');
  });

  test('listOpenIssues falls back to REST when gh fails', async () => {
    const calls: string[] = [];
    const service = new GitHubService({
      token: 'test-token',
      logger: new Logger({ silent: true }),
      allowedRepos: new Set<string>(),
      execCommandFn: async () => ({
        code: 1,
        stdout: '',
        stderr: 'gh unavailable',
      }),
    });

    setMockFetch(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);

      if (url.includes('/repos/acme/api/issues?')) {
        return jsonResponse([
          {
            number: 5,
            title: 'Issue from REST',
            body: 'details',
            state: 'open',
            labels: [{ name: 'bug' }],
            assignees: [{ login: 'dev2' }],
            milestone: { title: 'M1' },
            comments_url: 'https://api.github.com/comments',
            created_at: '2026-02-01T00:00:00.000Z',
            updated_at: '2026-02-02T00:00:00.000Z',
            html_url: 'https://github.com/acme/api/issues/5',
          },
          {
            number: 6,
            title: 'Pull request pseudo issue',
            body: null,
            state: 'open',
            labels: [],
            assignees: [],
            milestone: null,
            comments_url: 'https://api.github.com/comments',
            created_at: '2026-02-01T00:00:00.000Z',
            updated_at: '2026-02-02T00:00:00.000Z',
            html_url: 'https://github.com/acme/api/pull/6',
            pull_request: {},
          },
        ]);
      }

      return jsonResponse([]);
    });

    const issues = await service.listOpenIssues('acme/api', { label: 'bug' });

    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(5);
    expect(issues[0].labels).toEqual(['bug']);
    expect(calls.some((url) => url.includes('labels=bug'))).toBeTrue();
  });

  test('listOpenIssues falls back to REST when gh result hits list cap', async () => {
    const calls: string[] = [];
    const service = new GitHubService({
      token: 'test-token',
      logger: new Logger({ silent: true }),
      allowedRepos: new Set<string>(),
      execCommandFn: async (_command, args) => {
        if (args[0] === 'issue' && args[1] === 'list') {
          return {
            code: 0,
            stdout: JSON.stringify(
              Array.from({ length: 200 }, (_, index) => ({
                number: index + 1,
                title: `Issue ${index + 1}`,
                body: 'Details',
                labels: [{ name: 'bug' }],
                assignees: [{ login: 'dev1' }],
                createdAt: '2026-02-01T00:00:00.000Z',
                updatedAt: '2026-02-02T00:00:00.000Z',
                url: `https://github.com/acme/api/issues/${index + 1}`,
              })),
            ),
            stderr: '',
          };
        }

        return {
          code: 1,
          stdout: '',
          stderr: 'unexpected command',
        };
      },
    });

    setMockFetch(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);

      if (url.includes('/repos/acme/api/issues?')) {
        const page = new URL(url).searchParams.get('page');
        if (page === '1') {
          return jsonResponse([
            {
              number: 501,
              title: 'Issue from REST page 1',
              body: 'details',
              state: 'open',
              labels: [{ name: 'bug' }],
              assignees: [{ login: 'dev2' }],
              milestone: { title: 'M1' },
              comments_url: 'https://api.github.com/comments',
              created_at: '2026-02-01T00:00:00.000Z',
              updated_at: '2026-02-02T00:00:00.000Z',
              html_url: 'https://github.com/acme/api/issues/501',
            },
          ]);
        }

        if (page === '2') {
          return jsonResponse([]);
        }
      }

      throw new Error(`Unexpected URL in test: ${url}`);
    });

    const issues = await service.listOpenIssues('acme/api', {
      label: 'bug',
      milestone: 'M1',
    });

    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(501);
    expect(calls.some((url) => url.includes('labels=bug'))).toBeTrue();
    expect(calls.some((url) => url.includes('milestone=M1'))).toBeTrue();
  });

  test('getIssueDetails falls back to REST when gh fails', async () => {
    const service = new GitHubService({
      token: 'test-token',
      logger: new Logger({ silent: true }),
      allowedRepos: new Set<string>(),
      execCommandFn: async () => ({
        code: 1,
        stdout: '',
        stderr: 'gh unavailable',
      }),
    });

    const calls: string[] = [];
    setMockFetch(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);

      if (url.endsWith('/repos/acme/api/issues/42')) {
        return jsonResponse({
          number: 42,
          title: 'REST detail',
          body: 'body',
          state: 'open',
          labels: [{ name: 'P1' }],
          assignees: [{ login: 'dev3' }],
          milestone: null,
          comments_url: 'https://api.github.com/comments',
          created_at: '2026-02-01T00:00:00.000Z',
          updated_at: '2026-02-02T00:00:00.000Z',
          html_url: 'https://github.com/acme/api/issues/42',
        });
      }

      if (url.includes('/repos/acme/api/issues/42/comments')) {
        return jsonResponse([
          {
            body: 'Looks good',
            created_at: '2026-02-03T00:00:00.000Z',
            html_url: 'https://github.com/acme/api/issues/42#issuecomment-1',
            user: { login: 'reviewer1' },
          },
        ]);
      }

      throw new Error(`Unexpected URL in test: ${url}`);
    });

    const issue = await service.getIssueDetails('acme/api', 42);

    expect(issue.number).toBe(42);
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0].author).toBe('reviewer1');
    expect(calls).toHaveLength(2);
  });

  test('getIssueDetails paginates REST comments beyond first 100', async () => {
    const service = new GitHubService({
      token: 'test-token',
      logger: new Logger({ silent: true }),
      allowedRepos: new Set<string>(),
      execCommandFn: async () => ({
        code: 1,
        stdout: '',
        stderr: 'gh unavailable',
      }),
    });

    setMockFetch(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.endsWith('/repos/acme/api/issues/42')) {
        return jsonResponse({
          number: 42,
          title: 'REST detail',
          body: 'body',
          state: 'open',
          labels: [{ name: 'P1' }],
          assignees: [{ login: 'dev3' }],
          milestone: null,
          comments_url: 'https://api.github.com/comments',
          created_at: '2026-02-01T00:00:00.000Z',
          updated_at: '2026-02-02T00:00:00.000Z',
          html_url: 'https://github.com/acme/api/issues/42',
        });
      }

      if (url.includes('/repos/acme/api/issues/42/comments?')) {
        const page = new URL(url).searchParams.get('page');
        if (page === '1') {
          return jsonResponse(
            Array.from({ length: 100 }, (_, index) => ({
              body: `Comment ${index + 1}`,
              created_at: `2026-02-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
              html_url: `https://github.com/acme/api/issues/42#issuecomment-${index + 1}`,
              user: { login: `reviewer${index + 1}` },
            })),
          );
        }

        if (page === '2') {
          return jsonResponse([
            {
              body: 'Comment 101',
              created_at: '2026-02-20T00:00:00.000Z',
              html_url: 'https://github.com/acme/api/issues/42#issuecomment-101',
              user: { login: 'reviewer101' },
            },
            {
              body: 'Comment 102',
              created_at: '2026-02-21T00:00:00.000Z',
              html_url: 'https://github.com/acme/api/issues/42#issuecomment-102',
              user: { login: 'reviewer102' },
            },
          ]);
        }
      }

      throw new Error(`Unexpected URL in test: ${url}`);
    });

    const issue = await service.getIssueDetails('acme/api', 42);

    expect(issue.number).toBe(42);
    expect(issue.comments).toHaveLength(102);
    expect(issue.comments[0].author).toBe('reviewer1');
    expect(issue.comments[101].author).toBe('reviewer102');
  });

  test('listRepos with includeCounts=false does not call search API', async () => {
    const calls: string[] = [];
    const service = new GitHubService({
      token: 'test-token',
      logger: new Logger({ silent: true }),
      allowedRepos: new Set<string>(),
      execCommandFn: async () => ({
        code: 1,
        stdout: '',
        stderr: '',
      }),
    });

    setMockFetch(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer test-token');

      if (isReposPage(url, '1')) {
        return jsonResponse([
          {
            full_name: 'acme/api',
            name: 'api',
            private: false,
            description: 'API',
            html_url: 'https://github.com/acme/api',
            owner: { login: 'acme' },
            open_issues_count: 8,
          },
        ]);
      }

      if (isReposPage(url, '2')) {
        return jsonResponse([]);
      }

      throw new Error(`Unexpected URL in test: ${url}`);
    });

    const repos = await service.listRepos({ includeCounts: false });

    expect(repos).toHaveLength(1);
    expect(repos[0].open_issue_count).toBe(8);
    expect(calls.some((url) => url.includes('/search/issues'))).toBeFalse();
  });

  test('listRepos with includeCounts=true falls back to repo count on search failure', async () => {
    const service = new GitHubService({
      token: 'test-token',
      logger: new Logger({ silent: true }),
      allowedRepos: new Set<string>(),
      execCommandFn: async () => ({
        code: 1,
        stdout: '',
        stderr: '',
      }),
    });

    setMockFetch(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (isReposPage(url, '1')) {
        return jsonResponse([
          {
            full_name: 'acme/api',
            name: 'api',
            private: false,
            description: 'API',
            html_url: 'https://github.com/acme/api',
            owner: { login: 'acme' },
            open_issues_count: 7,
          },
        ]);
      }

      if (isReposPage(url, '2')) {
        return jsonResponse([]);
      }

      if (url.includes('/search/issues')) {
        return new Response('upstream failure', { status: 500 });
      }

      throw new Error(`Unexpected URL in test: ${url}`);
    });

    const repos = await service.listRepos({ includeCounts: true });
    expect(repos).toHaveLength(1);
    expect(repos[0].open_issue_count).toBe(7);
  });

  test('enforces ALLOWED_REPOS for issue operations', async () => {
    const service = new GitHubService({
      token: 'test-token',
      logger: new Logger({ silent: true }),
      allowedRepos: new Set<string>(['acme/allowed']),
      execCommandFn: async () => ({
        code: 0,
        stdout: '[]',
        stderr: '',
      }),
    });

    await expect(service.listOpenIssues('acme/blocked')).rejects.toThrow(
      'Repository acme/blocked is not allowed by ALLOWED_REPOS',
    );
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function setMockFetch(
  handler: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): void {
  const mock = handler as unknown as typeof fetch;
  mock.preconnect = ORIGINAL_FETCH.preconnect.bind(ORIGINAL_FETCH);
  globalThis.fetch = mock;
}

function isReposPage(url: string, page: string): boolean {
  const parsed = new URL(url);
  return parsed.pathname === '/user/repos' && parsed.searchParams.get('page') === page;
}
