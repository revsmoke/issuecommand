import { readFile } from 'node:fs/promises';
import { Logger } from '../logger';
import { FollowupPersistedState, PersistedState } from '../types';
import { SqliteStore, claimSnapshotNamespace, followupSnapshotNamespace } from './sqlite-store';

interface MigrationOptions {
  store: SqliteStore;
  logger: Logger;
  claimStateFilePath: string;
  followupStateFilePath: string;
  historyMaxEntries: number;
  followupMaxEntries: number;
  seenSourceIdMaxEntries?: number;
}

interface MigrationSummary {
  importedClaimsSnapshot: boolean;
  importedFollowupsSnapshot: boolean;
}

export async function migrateJsonStateToSqlite(options: MigrationOptions): Promise<MigrationSummary> {
  const claimsNamespace = claimSnapshotNamespace();
  const followupsNamespace = followupSnapshotNamespace();
  const hasClaimState = options.store.hasAnyClaimState();
  const hasFollowupState = options.store.hasAnyFollowupState();

  if (hasClaimState && hasFollowupState) {
    options.logger.info('sqlite.json_migration.skipped_existing_state');
    return {
      importedClaimsSnapshot: false,
      importedFollowupsSnapshot: false,
    };
  }

  const claimState = hasClaimState
    ? null
    : await loadLegacyClaimState(options.store, options.claimStateFilePath, claimsNamespace);
  const followupState = hasFollowupState
    ? null
    : await loadLegacyFollowupState(options.store, options.followupStateFilePath, followupsNamespace);

  let importedClaimsSnapshot = false;
  let importedFollowupsSnapshot = false;

  if (!hasClaimState && claimState) {
    options.store.replaceClaimState(claimState, options.historyMaxEntries);
    importedClaimsSnapshot = true;
  }

  if (!hasFollowupState && followupState) {
    options.store.replaceFollowupState(
      followupState,
      options.followupMaxEntries,
      options.seenSourceIdMaxEntries ?? 20_000,
    );
    importedFollowupsSnapshot = true;
  }

  options.logger.info('sqlite.json_migration.completed', {
    imported_claims_snapshot: importedClaimsSnapshot,
    imported_followups_snapshot: importedFollowupsSnapshot,
    claim_state_file_path: options.claimStateFilePath,
    followup_state_file_path: options.followupStateFilePath,
    sqlite_file_path: options.store.filePath,
  });

  return {
    importedClaimsSnapshot,
    importedFollowupsSnapshot,
  };
}

async function loadLegacyClaimState(
  store: SqliteStore,
  jsonPath: string,
  snapshotNamespace: string,
): Promise<PersistedState | null> {
  if (store.hasSnapshot(snapshotNamespace)) {
    return store.loadSnapshot<PersistedState>(snapshotNamespace);
  }

  return readOptionalJson<PersistedState>(jsonPath);
}

async function loadLegacyFollowupState(
  store: SqliteStore,
  jsonPath: string,
  snapshotNamespace: string,
): Promise<FollowupPersistedState | null> {
  if (store.hasSnapshot(snapshotNamespace)) {
    return store.loadSnapshot<FollowupPersistedState>(snapshotNamespace);
  }

  return readOptionalJson<FollowupPersistedState>(jsonPath);
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as T;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`JSON file has invalid shape: ${path}`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
