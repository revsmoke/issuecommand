import { Logger } from '../logger';
import { PersistenceDriver } from '../state-persistence';
import { SqliteStore } from './sqlite-store';

interface SqliteSnapshotPersistenceOptions {
  store: SqliteStore;
  namespace: string;
  logger: Logger;
  debounceMs?: number;
}

export class SqliteSnapshotPersistence<T> implements PersistenceDriver<T> {
  private readonly store: SqliteStore;
  private readonly namespace: string;
  private readonly logger: Logger;
  private readonly debounceMs: number;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pendingState?: T;

  constructor(options: SqliteSnapshotPersistenceOptions) {
    this.store = options.store;
    this.namespace = options.namespace;
    this.logger = options.logger;
    this.debounceMs = options.debounceMs ?? 200;
  }

  async load(): Promise<T | null> {
    try {
      return this.store.loadSnapshot<T>(this.namespace);
    } catch (error) {
      this.logger.error('sqlite.snapshot_load_failed', {
        namespace: this.namespace,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  scheduleSave(state: T): void {
    this.pendingState = state;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      void this.flush().catch(() => {
        // flush logs internally; swallow timer context errors
      });
    }, this.debounceMs);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }

    if (typeof this.pendingState === 'undefined') {
      return;
    }

    const snapshot = this.pendingState;
    this.pendingState = undefined;
    this.store.saveSnapshot(this.namespace, snapshot);
  }
}
