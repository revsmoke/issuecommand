import { dirname } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type {
  ClaimRecord,
  FollowupPersistedState,
  PersistedState,
  PrFollowupRecord,
} from './types';
import { Logger } from './logger';

interface StatePersistenceOptions {
  filePath: string;
  logger: Logger;
  debounceMs?: number;
}

export interface PersistenceDriver<T> {
  load(): Promise<T | null>;
  scheduleSave(state: T): void;
  flush(): Promise<void>;
}

export interface ClaimRuntimeMetadata {
  version: number;
  started_at: string;
  total_claims: number;
  last_github_sync_at?: string;
}

export interface ClaimIncrementalPersistence {
  readonly supportsIncrementalClaims: true;
  runClaimTransaction(fn: () => void): void;
  upsertClaimRuntime(runtime: ClaimRuntimeMetadata): void;
  upsertActiveClaim(claim: ClaimRecord): void;
  deleteActiveClaim(claimId: string): void;
  upsertClaimHistory(claim: ClaimRecord): void;
  trimClaimHistory(maxEntries: number): void;
}

export interface FollowupIncrementalPersistence {
  readonly supportsIncrementalFollowups: true;
  runFollowupTransaction(fn: () => void): void;
  upsertFollowupRuntime(version: number): void;
  upsertActiveFollowup(record: PrFollowupRecord): void;
  deleteActiveFollowup(workItemId: string): void;
  upsertFollowupHistory(record: PrFollowupRecord): void;
  trimFollowupHistory(maxEntries: number): void;
  upsertSeenSourceEvent(sourceEventId: string, seenAtIso: string): void;
  deleteSeenSourceEvent(sourceEventId: string): void;
  trimSeenSourceEvents(maxEntries: number): void;
}

export function isClaimIncrementalPersistence(
  driver: PersistenceDriver<PersistedState>,
): driver is PersistenceDriver<PersistedState> & ClaimIncrementalPersistence {
  return (driver as Partial<ClaimIncrementalPersistence>).supportsIncrementalClaims === true;
}

export function isFollowupIncrementalPersistence(
  driver: PersistenceDriver<FollowupPersistedState>,
): driver is PersistenceDriver<FollowupPersistedState> & FollowupIncrementalPersistence {
  return (driver as Partial<FollowupIncrementalPersistence>).supportsIncrementalFollowups === true;
}

export class StatePersistence<T = PersistedState> implements PersistenceDriver<T> {
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly debounceMs: number;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pendingState?: T;

  constructor(options: StatePersistenceOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger;
    this.debounceMs = options.debounceMs ?? 300;
  }

  async load(): Promise<T | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as T;
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Persisted state has invalid shape');
      }
      return parsed;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null;
      }

      this.logger.warn('state.load_failed', {
        path: this.filePath,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  scheduleSave(state: T): void {
    this.pendingState = state;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      void this.flush().catch(() => {
        // flush logs internally; swallow to avoid unhandled rejection from timer context
      });
    }, this.debounceMs);
  }

  async flush(): Promise<void> {
    if (!this.pendingState) {
      return;
    }

    const snapshot = this.pendingState;
    this.pendingState = undefined;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }

    const dir = dirname(this.filePath);
    const tempPath = `${this.filePath}.tmp`;

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(tempPath, JSON.stringify(snapshot, null, 2), 'utf8');
      await rename(tempPath, this.filePath);
    } catch (error) {
      this.logger.error('state.flush_failed', {
        path: this.filePath,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
