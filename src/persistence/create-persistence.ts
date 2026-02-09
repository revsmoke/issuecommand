import { Logger } from '../logger';
import type { PersistenceDriver } from '../state-persistence';
import type { AppConfig, FollowupPersistedState, PersistedState } from '../types';
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
  const sqliteStore = new SqliteStore({
    filePath: config.sqlitePath,
    logger,
    busyTimeoutMs: config.sqliteBusyTimeoutMs,
    journalMode: config.sqliteJournalMode,
    webhookDedupeMaxEntries: config.webhookDedupeMaxEntries,
  });
  await sqliteStore.initialize();

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
