import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FollowupManager } from '../src/followup-manager';
import { Logger } from '../src/logger';
import { SqliteFollowupPersistence } from '../src/persistence/sqlite-relational-persistence';
import { SqliteStore } from '../src/persistence/sqlite-store';
import {
  FollowupIncrementalPersistence,
  PersistenceDriver,
} from '../src/state-persistence';
import type { FollowupPersistedState } from '../src/types';

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

describe('FollowupManager', () => {
  test('uses incremental persistence hooks instead of snapshot saves when available', async () => {
    const calls = {
      scheduleSave: 0,
      runtimeUpserts: 0,
      activeUpserts: 0,
      activeDeletes: 0,
      historyUpserts: 0,
      historyTrims: 0,
      seenUpserts: 0,
      seenDeletes: 0,
      seenTrims: 0,
    };

    const persistence: PersistenceDriver<FollowupPersistedState> & FollowupIncrementalPersistence = {
      supportsIncrementalFollowups: true,
      async load() {
        return null;
      },
      scheduleSave() {
        calls.scheduleSave += 1;
      },
      async flush() {
        // no-op
      },
      runFollowupTransaction(fn: () => void) {
        fn();
      },
      upsertFollowupRuntime() {
        calls.runtimeUpserts += 1;
      },
      upsertActiveFollowup() {
        calls.activeUpserts += 1;
      },
      deleteActiveFollowup() {
        calls.activeDeletes += 1;
      },
      upsertFollowupHistory() {
        calls.historyUpserts += 1;
      },
      trimFollowupHistory() {
        calls.historyTrims += 1;
      },
      upsertSeenSourceEvent() {
        calls.seenUpserts += 1;
      },
      deleteSeenSourceEvent() {
        calls.seenDeletes += 1;
      },
      trimSeenSourceEvents() {
        calls.seenTrims += 1;
      },
    };

    const logger = new Logger({ silent: true });
    const manager = new FollowupManager({
      persistence,
      logger,
      maxEntries: 1000,
      staleMinutes: 1440,
    });
    await manager.initialize();

    const created = await manager.createFromWebhook({
      repo: 'acme/repo',
      pr_number: 99,
      pr_url: 'https://github.com/acme/repo/pull/99',
      pr_title: 'Improve persistence flow',
      source_event_type: 'review_comment',
      source_event_id: 'review:99',
      summary: 'Please address review comment',
      actionable_comments: ['Please address review comment'],
    });
    expect(created.ok).toBeTrue();

    const claimed = await manager.claimNextFollowup('agent-1', 'acme/repo');
    expect(claimed.ok).toBeTrue();
    if (!claimed.ok) {
      return;
    }

    const done = await manager.updateFollowupStatus({
      work_item_id: claimed.work_item!.work_item_id,
      status: 'done',
      agent_id: 'agent-1',
    });
    expect(done.ok).toBeTrue();

    expect(calls.scheduleSave).toBe(0);
    expect(calls.runtimeUpserts).toBeGreaterThan(0);
    expect(calls.activeUpserts).toBe(2);
    expect(calls.activeDeletes).toBe(1);
    expect(calls.historyUpserts).toBe(1);
    expect(calls.historyTrims).toBe(1);
    expect(calls.seenUpserts).toBe(1);
    expect(calls.seenTrims).toBe(1);
    expect(calls.seenDeletes).toBe(0);
  });

  test('persists synchronize source_event_id even when no active followups are resolved', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-followup-sync-seen-'));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, 'issuecommand.db');
    const logger = new Logger({ silent: true });

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
    });

    const manager = new FollowupManager({
      persistence,
      logger,
      maxEntries: 1000,
      staleMinutes: 1440,
    });
    await manager.initialize();

    const resolved = await manager.resolveBySynchronize({
      repo: 'acme/repo',
      pr_number: 123,
      source_event_id: 'pr_sync:acme/repo#123:sha1',
    });
    expect(resolved).toBe(0);

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
    expect(loaded?.seen_source_event_ids.includes('pr_sync:acme/repo#123:sha1')).toBeTrue();
    reopenedStore.close();
  });

  test('dedupes webhook source_event_id across restart after followup completion', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-followup-dedupe-restart-'));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, 'issuecommand.db');
    const logger = new Logger({ silent: true });

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
    });

    const manager = new FollowupManager({
      persistence,
      logger,
      maxEntries: 1000,
      staleMinutes: 1440,
    });
    await manager.initialize();

    const created = await manager.createFromWebhook({
      repo: 'acme/repo',
      pr_number: 500,
      pr_url: 'https://github.com/acme/repo/pull/500',
      pr_title: 'Improve dedupe',
      source_event_type: 'review_comment',
      source_event_id: 'review:500',
      summary: 'Please update naming',
      actionable_comments: ['Please update naming'],
    });
    expect(created.ok).toBeTrue();

    const claimed = await manager.claimNextFollowup('agent-1', 'acme/repo');
    expect(claimed.ok).toBeTrue();
    if (!claimed.ok || !claimed.work_item) {
      return;
    }

    const done = await manager.updateFollowupStatus({
      work_item_id: claimed.work_item.work_item_id,
      status: 'done',
      agent_id: 'agent-1',
    });
    expect(done.ok).toBeTrue();

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
    const reopenedManager = new FollowupManager({
      persistence: reopenedPersistence,
      logger,
      maxEntries: 1000,
      staleMinutes: 1440,
    });
    await reopenedManager.initialize();

    const duplicate = await reopenedManager.createFromWebhook({
      repo: 'acme/repo',
      pr_number: 500,
      pr_url: 'https://github.com/acme/repo/pull/500',
      pr_title: 'Improve dedupe',
      source_event_type: 'review_comment',
      source_event_id: 'review:500',
      summary: 'Please update naming',
      actionable_comments: ['Please update naming'],
    });

    expect(duplicate.ok).toBeTrue();
    expect(duplicate.idempotent).toBeTrue();
    expect(reopenedManager.listFollowups()).toHaveLength(0);
    expect(reopenedManager.getHistory(10).items).toHaveLength(1);

    reopenedStore.close();
  });

  test('dedupes seen source_event_id even when original history entry was trimmed', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-followup-dedupe-trimmed-'));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, 'issuecommand.db');
    const logger = new Logger({ silent: true });

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
      maxEntries: 1,
      seenSourceIdMaxEntries: 20000,
    });

    const manager = new FollowupManager({
      persistence,
      logger,
      maxEntries: 1,
      staleMinutes: 1440,
    });
    await manager.initialize();

    const createAndComplete = async (sourceEventId: string, prNumber: number): Promise<void> => {
      const created = await manager.createFromWebhook({
        repo: 'acme/repo',
        pr_number: prNumber,
        pr_url: `https://github.com/acme/repo/pull/${prNumber}`,
        pr_title: `PR ${prNumber}`,
        source_event_type: 'review_comment',
        source_event_id: sourceEventId,
        summary: `Followup ${prNumber}`,
        actionable_comments: [`Followup ${prNumber}`],
      });
      expect(created.ok).toBeTrue();

      const claimed = await manager.claimNextFollowup('agent-1', 'acme/repo');
      expect(claimed.ok).toBeTrue();
      if (!claimed.ok || !claimed.work_item) {
        return;
      }

      const done = await manager.updateFollowupStatus({
        work_item_id: claimed.work_item.work_item_id,
        status: 'done',
        agent_id: 'agent-1',
      });
      expect(done.ok).toBeTrue();
    };

    await createAndComplete('review:trimmed-first', 501);
    await createAndComplete('review:trimmed-second', 502);

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
      maxEntries: 1,
      seenSourceIdMaxEntries: 20000,
    });
    const reopenedManager = new FollowupManager({
      persistence: reopenedPersistence,
      logger,
      maxEntries: 1,
      staleMinutes: 1440,
    });
    await reopenedManager.initialize();

    expect(reopenedManager.getHistory(10).items).toHaveLength(1);

    const duplicate = await reopenedManager.createFromWebhook({
      repo: 'acme/repo',
      pr_number: 501,
      pr_url: 'https://github.com/acme/repo/pull/501',
      pr_title: 'PR 501',
      source_event_type: 'review_comment',
      source_event_id: 'review:trimmed-first',
      summary: 'Followup 501',
      actionable_comments: ['Followup 501'],
    });

    expect(duplicate.ok).toBeTrue();
    expect(duplicate.idempotent).toBeTrue();
    expect(reopenedManager.listFollowups()).toHaveLength(0);

    reopenedStore.close();
  });
});
