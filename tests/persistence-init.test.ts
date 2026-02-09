import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '../src/logger';
import { initializePersistence } from '../src/persistence/create-persistence';
import {
  SqliteClaimPersistence,
  SqliteFollowupPersistence,
} from '../src/persistence/sqlite-relational-persistence';
import type { AppConfig } from '../src/types';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }

    await rm(dir, { recursive: true, force: true });
  }
});

describe('initializePersistence', () => {
  test('initializes sqlite relational persistence drivers', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-persistence-init-'));
    tempDirs.push(tempDir);

    const logger = new Logger({ silent: true });
    const config = buildConfig({
      sqlitePath: join(tempDir, 'issuecommand.db'),
    });

    const initialized = await initializePersistence(config, logger);

    expect(initialized.sqliteStore).toBeDefined();
    expect(initialized.claimPersistence).toBeInstanceOf(SqliteClaimPersistence);
    expect(initialized.followupPersistence).toBeInstanceOf(SqliteFollowupPersistence);
    expect(await initialized.claimPersistence.load()).toBeNull();
    expect(await initialized.followupPersistence.load()).toBeNull();

    await initialized.claimPersistence.flush();
    await initialized.followupPersistence.flush();
    initialized.sqliteStore?.close();
  });
});

function buildConfig(overrides: Partial<AppConfig>): AppConfig {
  return {
    githubToken: 'test-token',
    apiKey: 'test-key',
    httpPort: 3100,
    sqlitePath: './issuecommand.db',
    sqliteBusyTimeoutMs: 5000,
    sqliteJournalMode: 'WAL',
    webhookDedupeMaxEntries: 20_000,
    webhookEnabled: true,
    webhookPath: '/api/webhooks/github',
    githubWebhookSecret: undefined,
    claimTimeoutMinutes: 120,
    staleAutoReleaseMinutes: 0,
    followupStaleMinutes: 1440,
    followupMaxEntries: 2000,
    historyMaxEntries: 1000,
    trustProxy: false,
    syncIntervalMinutes: 15,
    allowedRepos: new Set<string>(),
    logFile: undefined,
    autoCloseGithubIssue: false,
    rateLimit: {
      enabled: true,
      ipPerMinute: 120,
      ipBurst: 40,
      agentMutationsPerMinute: 40,
      agentMutationsBurst: 20,
      sseConnectPerMinute: 10,
      sseConnectBurst: 10,
    },
    ...overrides,
  };
}
