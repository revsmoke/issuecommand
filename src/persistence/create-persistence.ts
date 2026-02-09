import { Logger } from '../logger';
import type { PersistenceDriver } from '../state-persistence';
import { StatePersistence } from '../state-persistence';
import type { AppConfig, FollowupPersistedState, PersistedState } from '../types';
import { migrateJsonStateToSqlite } from './migrate-json-to-sqlite';
import {
  SqliteClaimPersistence,
  SqliteFollowupPersistence,
} from './sqlite-relational-persistence';
import { SqliteStore } from './sqlite-store';

const DEFAULT_FOLLOWUP_SEEN_SOURCE_ID_MAX_ENTRIES = 20_000;

export interface InitializedPersistence {
  claimPersistence: PersistenceDriver<PersistedState>;
  followupPersistence: PersistenceDriver<FollowupPersistedState>;
  sqliteStore?: SqliteStore;
}

export async function initializePersistence(
  config: AppConfig,
  logger: Logger,
): Promise<InitializedPersistence> {
  if (config.persistenceBackend === 'sqlite') {
    const sqliteStore = new SqliteStore({
      filePath: config.sqlitePath,
      logger,
      busyTimeoutMs: config.sqliteBusyTimeoutMs,
      journalMode: config.sqliteJournalMode,
      webhookDedupeMaxEntries: config.webhookDedupeMaxEntries,
    });
    await sqliteStore.initialize();

    if (config.migrateJsonToSqlite) {
      await migrateJsonStateToSqlite({
        store: sqliteStore,
        logger,
        claimStateFilePath: config.stateFilePath,
        followupStateFilePath: config.followupStateFilePath,
        historyMaxEntries: config.historyMaxEntries,
        followupMaxEntries: config.followupMaxEntries,
        seenSourceIdMaxEntries: DEFAULT_FOLLOWUP_SEEN_SOURCE_ID_MAX_ENTRIES,
      });
    }

    const claimPersistence = new SqliteClaimPersistence({
      store: sqliteStore,
      logger,
      historyMaxEntries: config.historyMaxEntries,
    });

    const followupPersistence = new SqliteFollowupPersistence({
      store: sqliteStore,
      logger,
      maxEntries: config.followupMaxEntries,
      seenSourceIdMaxEntries: DEFAULT_FOLLOWUP_SEEN_SOURCE_ID_MAX_ENTRIES,
    });

    return {
      claimPersistence,
      followupPersistence,
      sqliteStore,
    };
  }

  return {
    claimPersistence: new StatePersistence({
      filePath: config.stateFilePath,
      logger,
    }),
    followupPersistence: new StatePersistence<FollowupPersistedState>({
      filePath: config.followupStateFilePath,
      logger,
    }),
  };
}
