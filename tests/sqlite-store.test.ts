import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Logger } from '../src/logger';
import { migrateJsonStateToSqlite } from '../src/persistence/migrate-json-to-sqlite';
import {
  SqliteClaimPersistence,
  SqliteFollowupPersistence,
} from '../src/persistence/sqlite-relational-persistence';
import {
  SqliteStore,
  claimSnapshotNamespace,
  followupSnapshotNamespace,
} from '../src/persistence/sqlite-store';
import type { FollowupPersistedState, PersistedState, ClaimRecord, PrFollowupRecord } from '../src/types';

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

describe('SqliteStore relational persistence', () => {
  test('persists claim state across restarts without snapshot blobs', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-sqlite-claims-'));
    tempDirs.push(tempDir);

    const logger = new Logger({ silent: true });
    const dbPath = join(tempDir, 'issuecommand.db');

    const store = new SqliteStore({
      filePath: dbPath,
      logger,
      busyTimeoutMs: 1000,
      journalMode: 'WAL',
    });
    await store.initialize();

    const persistence = new SqliteClaimPersistence({
      store,
      logger,
      historyMaxEntries: 1000,
      debounceMs: 1,
    });

    const snapshot: PersistedState = {
      version: 1,
      started_at: '2026-02-08T00:00:00.000Z',
      total_claims: 2,
      last_github_sync_at: '2026-02-08T00:01:00.000Z',
      active_claims: [buildClaim({ issueNumber: 10, status: 'in_progress' })],
      history: [buildClaim({ issueNumber: 9, status: 'closed' })],
    };

    persistence.scheduleSave(snapshot);
    await persistence.flush();
    store.close();

    const reopenedStore = new SqliteStore({
      filePath: dbPath,
      logger,
      busyTimeoutMs: 1000,
      journalMode: 'WAL',
    });
    await reopenedStore.initialize();

    const reopenedPersistence = new SqliteClaimPersistence({
      store: reopenedStore,
      logger,
      historyMaxEntries: 1000,
    });

    const loaded = await reopenedPersistence.load();
    expect(loaded).toEqual(snapshot);
    reopenedStore.close();
  });

  test('persists followup state across restarts without snapshot blobs', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-sqlite-followups-'));
    tempDirs.push(tempDir);

    const logger = new Logger({ silent: true });
    const dbPath = join(tempDir, 'issuecommand.db');

    const store = new SqliteStore({
      filePath: dbPath,
      logger,
      busyTimeoutMs: 1000,
      journalMode: 'WAL',
    });
    await store.initialize();

    const persistence = new SqliteFollowupPersistence({
      store,
      logger,
      maxEntries: 1000,
      seenSourceIdMaxEntries: 20000,
      debounceMs: 1,
    });

    const state: FollowupPersistedState = {
      version: 1,
      active_followups: [buildFollowup({ workItemId: 'active-1', prNumber: 501, status: 'claimed' })],
      history: [buildFollowup({ workItemId: 'history-1', prNumber: 500, status: 'done' })],
      seen_source_event_ids: ['review:501', 'comment:500'],
    };

    persistence.scheduleSave(state);
    await persistence.flush();
    store.close();

    const reopenedStore = new SqliteStore({
      filePath: dbPath,
      logger,
      busyTimeoutMs: 1000,
      journalMode: 'WAL',
    });
    await reopenedStore.initialize();

    const reopenedPersistence = new SqliteFollowupPersistence({
      store: reopenedStore,
      logger,
      maxEntries: 1000,
      seenSourceIdMaxEntries: 20000,
    });

    const loaded = await reopenedPersistence.load();
    expect(loaded).toEqual(state);
    reopenedStore.close();
  });

  test('imports legacy JSON state into relational tables once', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-sqlite-migrate-json-'));
    tempDirs.push(tempDir);

    const logger = new Logger({ silent: true });
    const dbPath = join(tempDir, 'issuecommand.db');
    const claimsPath = join(tempDir, 'claims.json');
    const followupsPath = join(tempDir, 'followups.json');

    const claimState: PersistedState = {
      version: 1,
      started_at: '2026-02-08T00:00:00.000Z',
      total_claims: 3,
      last_github_sync_at: '2026-02-08T00:05:00.000Z',
      active_claims: [buildClaim({ issueNumber: 10, status: 'in_progress' })],
      history: [
        buildClaim({ issueNumber: 9, status: 'closed' }),
        buildClaim({ issueNumber: 8, status: 'released' }),
        buildClaim({ issueNumber: 7, status: 'closed' }),
      ],
    };

    const followupState: FollowupPersistedState = {
      version: 1,
      active_followups: [buildFollowup({ workItemId: 'active-1', prNumber: 501, status: 'queued' })],
      history: [
        buildFollowup({ workItemId: 'history-1', prNumber: 500, status: 'done' }),
        buildFollowup({ workItemId: 'history-2', prNumber: 499, status: 'dismissed' }),
        buildFollowup({ workItemId: 'history-3', prNumber: 498, status: 'done' }),
      ],
      seen_source_event_ids: ['review:501', 'comment:500', 'review:499'],
    };

    await writeFile(claimsPath, JSON.stringify(claimState, null, 2), 'utf8');
    await writeFile(followupsPath, JSON.stringify(followupState, null, 2), 'utf8');

    const store = new SqliteStore({
      filePath: dbPath,
      logger,
      busyTimeoutMs: 1000,
      journalMode: 'WAL',
    });
    await store.initialize();

    const summary = await migrateJsonStateToSqlite({
      store,
      logger,
      claimStateFilePath: claimsPath,
      followupStateFilePath: followupsPath,
      historyMaxEntries: 2,
      followupMaxEntries: 2,
      seenSourceIdMaxEntries: 2,
    });

    expect(summary.importedClaimsSnapshot).toBeTrue();
    expect(summary.importedFollowupsSnapshot).toBeTrue();

    const loadedClaimState = store.loadClaimState();
    const loadedFollowupState = store.loadFollowupState();
    expect(loadedClaimState).toEqual({
      ...claimState,
      history: claimState.history.slice(0, 2),
    });
    expect(loadedFollowupState).toEqual({
      ...followupState,
      history: followupState.history.slice(0, 2),
      seen_source_event_ids: followupState.seen_source_event_ids.slice(0, 2),
    });

    await writeFile(
      claimsPath,
      JSON.stringify({ ...claimState, total_claims: 999 }, null, 2),
      'utf8',
    );
    const summary2 = await migrateJsonStateToSqlite({
      store,
      logger,
      claimStateFilePath: claimsPath,
      followupStateFilePath: followupsPath,
      historyMaxEntries: 2,
      followupMaxEntries: 2,
      seenSourceIdMaxEntries: 2,
    });
    expect(summary2.importedClaimsSnapshot).toBeFalse();
    expect(summary2.importedFollowupsSnapshot).toBeFalse();
    expect(store.loadClaimState()?.total_claims).toBe(3);

    store.close();
  });

  test('imports legacy sqlite snapshot namespaces when relational tables are empty', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-sqlite-migrate-snapshot-'));
    tempDirs.push(tempDir);

    const logger = new Logger({ silent: true });
    const dbPath = join(tempDir, 'issuecommand.db');
    const claimsPath = join(tempDir, 'claims.json');
    const followupsPath = join(tempDir, 'followups.json');

    const claimState: PersistedState = {
      version: 1,
      started_at: '2026-02-08T00:00:00.000Z',
      total_claims: 1,
      last_github_sync_at: undefined,
      active_claims: [buildClaim({ issueNumber: 10, status: 'claimed' })],
      history: [],
    };
    const followupState: FollowupPersistedState = {
      version: 1,
      active_followups: [buildFollowup({ workItemId: 'active-1', prNumber: 100, status: 'queued' })],
      history: [],
      seen_source_event_ids: ['review:100'],
    };

    const store = new SqliteStore({
      filePath: dbPath,
      logger,
      busyTimeoutMs: 1000,
      journalMode: 'WAL',
    });
    await store.initialize();
    store.saveSnapshot(claimSnapshotNamespace(), claimState);
    store.saveSnapshot(followupSnapshotNamespace(), followupState);

    const summary = await migrateJsonStateToSqlite({
      store,
      logger,
      claimStateFilePath: claimsPath,
      followupStateFilePath: followupsPath,
      historyMaxEntries: 100,
      followupMaxEntries: 100,
      seenSourceIdMaxEntries: 100,
    });

    expect(summary.importedClaimsSnapshot).toBeTrue();
    expect(summary.importedFollowupsSnapshot).toBeTrue();
    expect(store.loadClaimState()).toEqual(claimState);
    expect(store.loadFollowupState()).toEqual(followupState);

    store.close();
  });

  test('imports missing namespace when relational db is partially populated', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-sqlite-partial-'));
    tempDirs.push(tempDir);

    const logger = new Logger({ silent: true });
    const dbPath = join(tempDir, 'issuecommand.db');
    const claimsPath = join(tempDir, 'claims.json');
    const followupsPath = join(tempDir, 'followups.json');

    const existingClaimState: PersistedState = {
      version: 1,
      started_at: '2026-02-08T00:00:00.000Z',
      total_claims: 5,
      last_github_sync_at: '2026-02-08T00:01:00.000Z',
      active_claims: [buildClaim({ issueNumber: 1, status: 'claimed' })],
      history: [buildClaim({ issueNumber: 2, status: 'released' })],
    };
    const followupState: FollowupPersistedState = {
      version: 1,
      active_followups: [buildFollowup({ workItemId: 'active-1', prNumber: 200, status: 'queued' })],
      history: [],
      seen_source_event_ids: ['review:partial-1'],
    };

    await writeFile(claimsPath, JSON.stringify({ ...existingClaimState, total_claims: 999 }, null, 2), 'utf8');
    await writeFile(followupsPath, JSON.stringify(followupState, null, 2), 'utf8');

    const store = new SqliteStore({
      filePath: dbPath,
      logger,
      busyTimeoutMs: 1000,
      journalMode: 'WAL',
    });
    await store.initialize();
    store.replaceClaimState(existingClaimState, 1000);

    const summary = await migrateJsonStateToSqlite({
      store,
      logger,
      claimStateFilePath: claimsPath,
      followupStateFilePath: followupsPath,
      historyMaxEntries: 1000,
      followupMaxEntries: 1000,
      seenSourceIdMaxEntries: 1000,
    });

    expect(summary.importedClaimsSnapshot).toBeFalse();
    expect(summary.importedFollowupsSnapshot).toBeTrue();

    expect(store.loadClaimState()?.total_claims).toBe(5);
    expect(store.loadFollowupState()).toEqual(followupState);

    store.close();
  });

  test('dedupes webhook deliveries across restarts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-sqlite-webhook-'));
    tempDirs.push(tempDir);

    const logger = new Logger({ silent: true });
    const dbPath = join(tempDir, 'issuecommand.db');

    const store = new SqliteStore({
      filePath: dbPath,
      logger,
      busyTimeoutMs: 1000,
      journalMode: 'WAL',
      webhookDedupeMaxEntries: 100,
    });
    await store.initialize();

    expect(await store.markWebhookDeliveryIfNew('delivery-1')).toBeTrue();
    expect(await store.markWebhookDeliveryIfNew('delivery-1')).toBeFalse();
    store.close();

    const reopenedStore = new SqliteStore({
      filePath: dbPath,
      logger,
      busyTimeoutMs: 1000,
      journalMode: 'WAL',
      webhookDedupeMaxEntries: 100,
    });
    await reopenedStore.initialize();
    expect(await reopenedStore.markWebhookDeliveryIfNew('delivery-1')).toBeFalse();
    expect(await reopenedStore.markWebhookDeliveryIfNew('delivery-2')).toBeTrue();
    reopenedStore.close();
  });

  test('throws on corrupted relational payload to keep startup fail-fast', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-sqlite-corrupt-'));
    tempDirs.push(tempDir);

    const logger = new Logger({ silent: true });
    const dbPath = join(tempDir, 'issuecommand.db');

    const store = new SqliteStore({
      filePath: dbPath,
      logger,
      busyTimeoutMs: 1000,
      journalMode: 'WAL',
    });
    await store.initialize();

    const persistence = new SqliteClaimPersistence({
      store,
      logger,
      historyMaxEntries: 1000,
      debounceMs: 1,
    });

    persistence.scheduleSave({
      version: 1,
      started_at: '2026-02-08T00:00:00.000Z',
      total_claims: 1,
      active_claims: [buildClaim({ issueNumber: 123, status: 'claimed' })],
      history: [],
    });
    await persistence.flush();
    store.close();

    const corruptor = new Database(dbPath);
    corruptor.exec(`UPDATE claim_active SET payload_json = '"corrupted"'`);
    corruptor.close();

    const reopenedStore = new SqliteStore({
      filePath: dbPath,
      logger,
      busyTimeoutMs: 1000,
      journalMode: 'WAL',
    });
    await reopenedStore.initialize();
    const reopenedPersistence = new SqliteClaimPersistence({
      store: reopenedStore,
      logger,
      historyMaxEntries: 1000,
    });

    await expect(reopenedPersistence.load()).rejects.toThrow('invalid payload');
    reopenedStore.close();
  });
});

function buildClaim(input: {
  issueNumber: number;
  status: ClaimRecord['status'];
  claimId?: string;
  timestamp?: string;
}): ClaimRecord {
  const timestamp = input.timestamp ?? '2026-02-08T00:00:00.000Z';
  const claim: ClaimRecord = {
    claim_id: input.claimId ?? `claim-${input.issueNumber}`,
    agent_id: `agent-${input.issueNumber}`,
    repo: 'acme/repo',
    issue_number: input.issueNumber,
    issue_title: `Issue ${input.issueNumber}`,
    issue_labels: [],
    issue_assignees: [],
    status: input.status,
    claimed_at: timestamp,
    last_updated: timestamp,
    status_history: [
      {
        status: 'claimed',
        timestamp,
      },
      {
        status: input.status,
        timestamp,
      },
    ],
  };

  if (input.status === 'pr_submitted') {
    claim.pr_url = `https://github.com/acme/repo/pull/${input.issueNumber}`;
  }

  return claim;
}

function buildFollowup(input: {
  workItemId: string;
  prNumber: number;
  status: PrFollowupRecord['status'];
  sourceEventId?: string;
  timestamp?: string;
}): PrFollowupRecord {
  const timestamp = input.timestamp ?? '2026-02-08T00:00:00.000Z';
  const record: PrFollowupRecord = {
    work_item_id: input.workItemId,
    repo: 'acme/repo',
    pr_number: input.prNumber,
    pr_url: `https://github.com/acme/repo/pull/${input.prNumber}`,
    pr_title: `PR ${input.prNumber}`,
    source_event_type: 'review_comment',
    source_event_id: input.sourceEventId ?? `source:${input.workItemId}`,
    source_delivery_id: `delivery:${input.workItemId}`,
    requested_by: 'reviewer',
    summary: 'Address review feedback',
    actionable_comments: ['Address review feedback'],
    status: input.status,
    created_at: timestamp,
    last_updated: timestamp,
    status_history: [
      {
        status: 'queued',
        timestamp,
      },
      {
        status: input.status,
        timestamp,
      },
    ],
  };

  if (input.status !== 'queued') {
    record.claimed_by_agent_id = 'agent-followup';
    record.claimed_at = timestamp;
  }
  if (input.status === 'done') {
    record.done_at = timestamp;
  }
  if (input.status === 'dismissed') {
    record.dismiss_reason = 'Not actionable';
  }

  return record;
}
