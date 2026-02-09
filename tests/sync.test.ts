import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { ClaimManager } from '../src/claim-manager';
import type { GitHubClient } from '../src/github';
import { Logger } from '../src/logger';
import { StatePersistence } from '../src/state-persistence';
import { SyncService } from '../src/sync';
import { buildIssue, FakeGitHubClient } from './test-helpers';

const tempDirs: string[] = [];
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
interface LogEntry {
  level: LogLevel;
  event: string;
  details?: unknown;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (!path) {
      continue;
    }
    await rm(path, { recursive: true, force: true });
  }
});

describe('SyncService', () => {
  test('tracks newly opened issues between reconciliation runs', async () => {
    const logger = new Logger({ silent: true });
    const claims = await createClaimManager(logger);
    const github = new FakeGitHubClient({
      repos: [{ full_name: 'acme/api' }],
      issues: [buildIssue({ repo: 'acme/api', number: 1 })],
    });

    const sync = new SyncService({
      claims,
      github,
      logger,
      intervalMinutes: 60,
      allowedRepos: new Set<string>(),
    });

    const first = await sync.runOnce();
    expect(first.repos_scanned).toBe(1);
    expect(first.newly_opened_issues).toBe(0);

    github.seedIssue(buildIssue({ repo: 'acme/api', number: 2 }));
    const second = await sync.runOnce();

    expect(second.repos_scanned).toBe(1);
    expect(second.open_issues_seen).toBe(2);
    expect(second.newly_opened_issues).toBe(1);
    expect(claims.getSystemHealth().last_github_sync_at).toBeString();
  });

  test('marks claims closed when issues are externally closed', async () => {
    const logger = new Logger({ silent: true });
    const claims = await createClaimManager(logger);
    const github = new FakeGitHubClient({
      repos: [{ full_name: 'acme/api' }],
      issues: [buildIssue({ repo: 'acme/api', number: 10 })],
    });

    await claims.claimIssue({
      agent_id: 'agent-1',
      repo: 'acme/api',
      issue_number: 10,
      issue_title: 'Issue 10',
      issue_labels: [],
      issue_assignees: [],
    });

    await github.closeIssue('acme/api', 10);

    const sync = new SyncService({
      claims,
      github,
      logger,
      intervalMinutes: 60,
      allowedRepos: new Set<string>(),
    });

    const report = await sync.runOnce();

    expect(report.externally_closed_claims).toBe(1);
    expect(claims.getActiveClaims()).toHaveLength(0);
    const history = claims.getHistory(10);
    expect(history.items[0]?.status).toBe('closed');
  });

  test('continues reconciliation when a repo scan fails', async () => {
    const logger = new Logger({ silent: true });
    const claims = await createClaimManager(logger);

    const github: GitHubClient = {
      async listRepos() {
        return [
          {
            full_name: 'acme/failing',
            owner: 'acme',
            name: 'failing',
            url: 'https://github.com/acme/failing',
            private: false,
            open_issue_count: 1,
          },
          {
            full_name: 'acme/healthy',
            owner: 'acme',
            name: 'healthy',
            url: 'https://github.com/acme/healthy',
            private: false,
            open_issue_count: 1,
          },
        ];
      },
      async listOpenIssues(repo: string) {
        if (repo === 'acme/failing') {
          throw new Error('temporary GitHub error');
        }
        return [buildIssue({ repo: 'acme/healthy', number: 1 })];
      },
      async getIssueDetails() {
        throw new Error('unused');
      },
      async closeIssue() {
        return true;
      },
    };

    const sync = new SyncService({
      claims,
      github,
      logger,
      intervalMinutes: 60,
      allowedRepos: new Set<string>(),
    });

    const report = await sync.runOnce();

    expect(report.repos_scanned).toBe(1);
    expect(report.open_issues_seen).toBe(1);
  });

  test('start is idempotent and stop is safe when called repeatedly', async () => {
    const logger = new Logger({ silent: true });
    const claims = await createClaimManager(logger);
    const github = new FakeGitHubClient({
      repos: [{ full_name: 'acme/api' }],
      issues: [buildIssue({ repo: 'acme/api', number: 1 })],
    });

    const sync = new SyncService({
      claims,
      github,
      logger,
      intervalMinutes: 60,
      allowedRepos: new Set<string>(),
    });

    let runs = 0;
    (sync as unknown as { runOnce: () => Promise<unknown> }).runOnce = async () => {
      runs += 1;
      return {
        repos_scanned: 0,
        open_issues_seen: 0,
        newly_opened_issues: 0,
        externally_closed_claims: 0,
        metadata_updates: 0,
      };
    };

    sync.start();
    sync.start();
    await Bun.sleep(5);
    sync.stop();
    sync.stop();

    expect(runs).toBe(1);
  });

  test('queues one rerun when schedule is triggered during in-flight execution', async () => {
    const logger = new Logger({ silent: true });
    const claims = await createClaimManager(logger);
    const github = new FakeGitHubClient({
      repos: [{ full_name: 'acme/api' }],
      issues: [buildIssue({ repo: 'acme/api', number: 1 })],
    });

    const sync = new SyncService({
      claims,
      github,
      logger,
      intervalMinutes: 60,
      allowedRepos: new Set<string>(),
    });

    let runs = 0;
    let releaseFirstRun: (() => void) | undefined;

    (sync as unknown as { runOnce: () => Promise<unknown> }).runOnce = async () => {
      runs += 1;
      if (runs === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstRun = resolve;
        });
      }
      return {
        repos_scanned: 0,
        open_issues_seen: 0,
        newly_opened_issues: 0,
        externally_closed_claims: 0,
        metadata_updates: 0,
      };
    };

    const first = (sync as unknown as { scheduleSyncRun: (trigger: string) => Promise<void> }).scheduleSyncRun(
      'startup',
    );
    await Bun.sleep(5);

    const second = (sync as unknown as { scheduleSyncRun: (trigger: string) => Promise<void> }).scheduleSyncRun(
      'interval',
    );
    expect(runs).toBe(1);

    releaseFirstRun?.();
    await Promise.all([first, second]);

    expect(runs).toBe(2);
  });

  test('scheduled sync failures are caught and logged', async () => {
    const { logger, entries } = createRecordingLogger();
    const claims = await createClaimManager(logger);
    const github = new FakeGitHubClient({
      repos: [{ full_name: 'acme/api' }],
      issues: [buildIssue({ repo: 'acme/api', number: 1 })],
    });

    const sync = new SyncService({
      claims,
      github,
      logger,
      intervalMinutes: 60,
      allowedRepos: new Set<string>(),
    });

    let runs = 0;
    (sync as unknown as { runOnce: () => Promise<unknown> }).runOnce = async () => {
      runs += 1;
      throw new Error('forced sync failure');
    };

    await (sync as unknown as { scheduleSyncRun: (trigger: string) => Promise<void> }).scheduleSyncRun(
      'startup',
    );

    expect(runs).toBe(1);
    const errorLog = entries.find((entry) => entry.level === 'error' && entry.event === 'sync.run_failed');
    expect(errorLog).toBeDefined();
    expect(String((errorLog?.details as { message?: string })?.message ?? '')).toContain(
      'forced sync failure',
    );
  });
});

async function createClaimManager(logger: Logger): Promise<ClaimManager> {
  const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-sync-'));
  tempDirs.push(tempDir);

  const persistence = new StatePersistence({
    filePath: join(tempDir, 'state.json'),
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
  return claims;
}

function createRecordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger = {
    debug(event: string, details?: unknown) {
      entries.push({ level: 'debug', event, details });
    },
    info(event: string, details?: unknown) {
      entries.push({ level: 'info', event, details });
    },
    warn(event: string, details?: unknown) {
      entries.push({ level: 'warn', event, details });
    },
    error(event: string, details?: unknown) {
      entries.push({ level: 'error', event, details });
    },
  } as Logger;

  return { logger, entries };
}
