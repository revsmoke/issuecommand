import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '../src/logger';
import { initializePersistence } from '../src/persistence/create-persistence';
import {
  SqliteClaimPersistence,
  SqliteFollowupPersistence,
} from '../src/persistence/sqlite-relational-persistence';
import { StatePersistence } from '../src/state-persistence';
import type { AppConfig, FollowupPersistedState, PersistedState } from '../src/types';

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
  test('uses sqlite drivers and migrates legacy files when enabled', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-persistence-init-'));
    tempDirs.push(tempDir);

    const statePath = join(tempDir, 'claims.json');
    const followupPath = join(tempDir, 'followups.json');
    const sqlitePath = join(tempDir, 'issuecommand.db');

    const claims: PersistedState = {
      version: 1,
      started_at: '2026-02-08T00:00:00.000Z',
      total_claims: 3,
      active_claims: [],
      history: [
        buildClosedClaim(1),
        buildClosedClaim(2),
        buildClosedClaim(3),
      ],
    };
    const followups: FollowupPersistedState = {
      version: 1,
      active_followups: [],
      history: [],
      seen_source_event_ids: ['review:1', 'review:2', 'review:3'],
    };

    await writeFile(statePath, JSON.stringify(claims, null, 2), 'utf8');
    await writeFile(followupPath, JSON.stringify(followups, null, 2), 'utf8');

    const logger = new Logger({ silent: true });
    const config = buildConfig({
      persistenceBackend: 'sqlite',
      sqlitePath,
      stateFilePath: statePath,
      followupStateFilePath: followupPath,
      migrateJsonToSqlite: true,
      historyMaxEntries: 2,
      followupMaxEntries: 2,
    });

    const initialized = await initializePersistence(config, logger);

    expect(initialized.sqliteStore).toBeDefined();
    expect(initialized.claimPersistence).toBeInstanceOf(SqliteClaimPersistence);
    expect(initialized.followupPersistence).toBeInstanceOf(SqliteFollowupPersistence);

    const loadedClaims = await initialized.claimPersistence.load();
    const loadedFollowups = await initialized.followupPersistence.load();
    expect(loadedClaims?.history.length).toBe(2);
    expect(loadedFollowups?.seen_source_event_ids.length).toBe(3);

    await initialized.claimPersistence.flush();
    await initialized.followupPersistence.flush();
    initialized.sqliteStore?.close();
  });

  test('skips sqlite migration when disabled', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-persistence-init-nomigrate-'));
    tempDirs.push(tempDir);

    const statePath = join(tempDir, 'claims.json');
    const followupPath = join(tempDir, 'followups.json');
    const sqlitePath = join(tempDir, 'issuecommand.db');

    await writeFile(
      statePath,
      JSON.stringify(
        {
          version: 1,
          started_at: '2026-02-08T00:00:00.000Z',
          total_claims: 1,
          active_claims: [],
          history: [buildClosedClaim(1)],
        } satisfies PersistedState,
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(
      followupPath,
      JSON.stringify(
        {
          version: 1,
          active_followups: [],
          history: [],
          seen_source_event_ids: ['review:1'],
        } satisfies FollowupPersistedState,
        null,
        2,
      ),
      'utf8',
    );

    const logger = new Logger({ silent: true });
    const config = buildConfig({
      persistenceBackend: 'sqlite',
      sqlitePath,
      stateFilePath: statePath,
      followupStateFilePath: followupPath,
      migrateJsonToSqlite: false,
    });

    const initialized = await initializePersistence(config, logger);
    const loadedClaims = await initialized.claimPersistence.load();
    const loadedFollowups = await initialized.followupPersistence.load();

    expect(loadedClaims).toBeNull();
    expect(loadedFollowups).toBeNull();

    await initialized.claimPersistence.flush();
    await initialized.followupPersistence.flush();
    initialized.sqliteStore?.close();
  });

  test('uses JSON persistence when configured', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-persistence-init-json-'));
    tempDirs.push(tempDir);

    const logger = new Logger({ silent: true });
    const config = buildConfig({
      persistenceBackend: 'json',
      sqlitePath: join(tempDir, 'issuecommand.db'),
      stateFilePath: join(tempDir, 'claims.json'),
      followupStateFilePath: join(tempDir, 'followups.json'),
      migrateJsonToSqlite: false,
    });

    const initialized = await initializePersistence(config, logger);

    expect(initialized.sqliteStore).toBeUndefined();
    expect(initialized.claimPersistence).toBeInstanceOf(StatePersistence);
    expect(initialized.followupPersistence).toBeInstanceOf(StatePersistence);

    await initialized.claimPersistence.flush();
    await initialized.followupPersistence.flush();
  });
});

function buildConfig(overrides: Partial<AppConfig>): AppConfig {
  return {
    githubToken: 'test-token',
    apiKey: 'test-key',
    httpPort: 3100,
    persistenceBackend: 'sqlite',
    sqlitePath: './issuecommand.db',
    sqliteBusyTimeoutMs: 5000,
    sqliteJournalMode: 'WAL',
    migrateJsonToSqlite: true,
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
    stateFilePath: './issuecommand-state.json',
    followupStateFilePath: './issuecommand-followups-state.json',
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

function buildClosedClaim(issueNumber: number): PersistedState['history'][number] {
  return {
    claim_id: `claim-${issueNumber}`,
    agent_id: `agent-${issueNumber}`,
    repo: 'acme/repo',
    issue_number: issueNumber,
    issue_title: `Issue ${issueNumber}`,
    issue_labels: [],
    issue_assignees: [],
    status: 'closed',
    claimed_at: '2026-02-08T00:00:00.000Z',
    last_updated: '2026-02-08T00:00:00.000Z',
    status_history: [
      {
        status: 'claimed',
        timestamp: '2026-02-08T00:00:00.000Z',
      },
      {
        status: 'closed',
        timestamp: '2026-02-08T00:00:00.000Z',
      },
    ],
  };
}
