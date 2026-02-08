import { dirname } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { PersistedState } from './types';
import { Logger } from './logger';

interface StatePersistenceOptions {
  filePath: string;
  logger: Logger;
  debounceMs?: number;
}

export class StatePersistence {
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly debounceMs: number;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pendingState?: PersistedState;

  constructor(options: StatePersistenceOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger;
    this.debounceMs = options.debounceMs ?? 300;
  }

  async load(): Promise<PersistedState | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
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

  scheduleSave(state: PersistedState): void {
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
