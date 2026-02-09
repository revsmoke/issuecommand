import { Logger } from '../logger';
import type {
  ClaimIncrementalPersistence,
  ClaimRuntimeMetadata,
  FollowupIncrementalPersistence,
  PersistenceDriver,
} from '../state-persistence';
import type { FollowupPersistedState, PersistedState, ClaimRecord, PrFollowupRecord } from '../types';
import { SqliteStore } from './sqlite-store';

interface SqliteClaimPersistenceOptions {
  store: SqliteStore;
  logger: Logger;
  historyMaxEntries: number;
  debounceMs?: number;
}

interface SqliteFollowupPersistenceOptions {
  store: SqliteStore;
  logger: Logger;
  maxEntries: number;
  seenSourceIdMaxEntries: number;
  debounceMs?: number;
}

export class SqliteClaimPersistence
implements PersistenceDriver<PersistedState>, ClaimIncrementalPersistence {
  readonly supportsIncrementalClaims = true as const;
  private readonly store: SqliteStore;
  private readonly logger: Logger;
  private readonly historyMaxEntries: number;
  private readonly debounceMs: number;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pendingState?: PersistedState;
  private lastState: PersistedState | null = null;

  constructor(options: SqliteClaimPersistenceOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.historyMaxEntries = Math.max(0, options.historyMaxEntries);
    this.debounceMs = options.debounceMs ?? 200;
  }

  async load(): Promise<PersistedState | null> {
    const loaded = this.store.loadClaimState();
    if (!loaded) {
      this.lastState = null;
      return null;
    }

    const normalized = normalizeClaimState(loaded, this.historyMaxEntries);
    if (normalized.history.length !== loaded.history.length) {
      this.store.runInTransaction(() => {
        this.store.trimClaimHistory(this.historyMaxEntries);
      });
    }

    this.lastState = structuredClone(normalized);
    return structuredClone(normalized);
  }

  runClaimTransaction(fn: () => void): void {
    this.store.runInTransaction(fn);
  }

  upsertClaimRuntime(runtime: ClaimRuntimeMetadata): void {
    this.store.upsertClaimRuntimeState({
      version: runtime.version,
      startedAt: runtime.started_at,
      totalClaims: runtime.total_claims,
      lastGithubSyncAt: runtime.last_github_sync_at,
    });
  }

  upsertActiveClaim(claim: ClaimRecord): void {
    this.store.upsertClaimActive(claim);
  }

  deleteActiveClaim(claimId: string): void {
    this.store.deleteClaimActive(claimId);
  }

  upsertClaimHistory(claim: ClaimRecord): void {
    this.store.upsertClaimHistory(claim);
  }

  trimClaimHistory(maxEntries: number): void {
    this.store.trimClaimHistory(maxEntries);
  }

  scheduleSave(state: PersistedState): void {
    this.pendingState = normalizeClaimState(state, this.historyMaxEntries);

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

    if (!this.pendingState) {
      return;
    }

    const next = this.pendingState;
    this.pendingState = undefined;

    try {
      this.store.runInTransaction(() => {
        applyClaimStateDelta(this.store, this.lastState, next, this.historyMaxEntries);
      });
      this.lastState = structuredClone(next);
    } catch (error) {
      this.logger.error('sqlite.claim_flush_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export class SqliteFollowupPersistence
implements PersistenceDriver<FollowupPersistedState>, FollowupIncrementalPersistence {
  readonly supportsIncrementalFollowups = true as const;
  private readonly store: SqliteStore;
  private readonly logger: Logger;
  private readonly maxEntries: number;
  private readonly seenSourceIdMaxEntries: number;
  private readonly debounceMs: number;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pendingState?: FollowupPersistedState;
  private lastState: FollowupPersistedState | null = null;

  constructor(options: SqliteFollowupPersistenceOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.maxEntries = Math.max(0, options.maxEntries);
    this.seenSourceIdMaxEntries = Math.max(1, options.seenSourceIdMaxEntries);
    this.debounceMs = options.debounceMs ?? 200;
  }

  async load(): Promise<FollowupPersistedState | null> {
    const loaded = this.store.loadFollowupState();
    if (!loaded) {
      this.lastState = null;
      return null;
    }

    const normalized = normalizeFollowupState(loaded, this.maxEntries, this.seenSourceIdMaxEntries);
    if (
      normalized.history.length !== loaded.history.length ||
      normalized.seen_source_event_ids.length !== loaded.seen_source_event_ids.length
    ) {
      this.store.runInTransaction(() => {
        this.store.trimFollowupHistory(this.maxEntries);
        this.store.trimSeenSourceEvents(this.seenSourceIdMaxEntries);
      });
    }

    this.lastState = structuredClone(normalized);
    return structuredClone(normalized);
  }

  runFollowupTransaction(fn: () => void): void {
    this.store.runInTransaction(fn);
  }

  upsertFollowupRuntime(version: number): void {
    this.store.upsertFollowupRuntimeState({ version });
  }

  upsertActiveFollowup(record: PrFollowupRecord): void {
    this.store.upsertFollowupActive(record);
  }

  deleteActiveFollowup(workItemId: string): void {
    this.store.deleteFollowupActive(workItemId);
  }

  upsertFollowupHistory(record: PrFollowupRecord): void {
    this.store.upsertFollowupHistory(record);
  }

  trimFollowupHistory(maxEntries: number): void {
    this.store.trimFollowupHistory(maxEntries);
  }

  upsertSeenSourceEvent(sourceEventId: string, seenAtIso: string): void {
    this.store.upsertSeenSourceEvent(sourceEventId, seenAtIso);
  }

  deleteSeenSourceEvent(sourceEventId: string): void {
    this.store.deleteSeenSourceEvent(sourceEventId);
  }

  trimSeenSourceEvents(maxEntries: number): void {
    this.store.trimSeenSourceEvents(maxEntries);
  }

  scheduleSave(state: FollowupPersistedState): void {
    this.pendingState = normalizeFollowupState(state, this.maxEntries, this.seenSourceIdMaxEntries);

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

    if (!this.pendingState) {
      return;
    }

    const next = this.pendingState;
    this.pendingState = undefined;

    try {
      this.store.runInTransaction(() => {
        applyFollowupStateDelta(
          this.store,
          this.lastState,
          next,
          this.maxEntries,
          this.seenSourceIdMaxEntries,
        );
      });
      this.lastState = structuredClone(next);
    } catch (error) {
      this.logger.error('sqlite.followup_flush_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

function applyClaimStateDelta(
  store: SqliteStore,
  previous: PersistedState | null,
  next: PersistedState,
  historyMaxEntries: number,
): void {
  if (
    !previous ||
    previous.version !== next.version ||
    previous.started_at !== next.started_at ||
    previous.total_claims !== next.total_claims ||
    previous.last_github_sync_at !== next.last_github_sync_at
  ) {
    store.upsertClaimRuntimeState({
      version: next.version,
      startedAt: next.started_at,
      totalClaims: next.total_claims,
      lastGithubSyncAt: next.last_github_sync_at,
    });
  }

  const previousActive = toMap(previous?.active_claims ?? [], (claim) => claim.claim_id);
  const nextActive = toMap(next.active_claims, (claim) => claim.claim_id);
  for (const [claimId, claim] of nextActive.entries()) {
    const prev = previousActive.get(claimId);
    if (!prev || !jsonEqual(prev, claim)) {
      store.upsertClaimActive(claim);
    }
  }
  for (const claimId of previousActive.keys()) {
    if (!nextActive.has(claimId)) {
      store.deleteClaimActive(claimId);
    }
  }

  const previousHistory = toMap(previous?.history ?? [], (claim) => claim.claim_id);
  const nextHistoryIds = new Set<string>();
  for (let index = next.history.length - 1; index >= 0; index -= 1) {
    const claim = next.history[index];
    nextHistoryIds.add(claim.claim_id);
    const prev = previousHistory.get(claim.claim_id);
    if (!prev || !jsonEqual(prev, claim)) {
      store.upsertClaimHistory(claim);
    }
  }
  for (const claimId of previousHistory.keys()) {
    if (!nextHistoryIds.has(claimId)) {
      store.deleteClaimHistory(claimId);
    }
  }

  store.trimClaimHistory(historyMaxEntries);
}

function applyFollowupStateDelta(
  store: SqliteStore,
  previous: FollowupPersistedState | null,
  next: FollowupPersistedState,
  maxEntries: number,
  seenSourceIdMaxEntries: number,
): void {
  if (!previous || previous.version !== next.version) {
    store.upsertFollowupRuntimeState({
      version: next.version,
    });
  }

  const previousActive = toMap(previous?.active_followups ?? [], (record) => record.work_item_id);
  const nextActive = toMap(next.active_followups, (record) => record.work_item_id);
  for (const [workItemId, record] of nextActive.entries()) {
    const prev = previousActive.get(workItemId);
    if (!prev || !jsonEqual(prev, record)) {
      store.upsertFollowupActive(record);
    }
  }
  for (const workItemId of previousActive.keys()) {
    if (!nextActive.has(workItemId)) {
      store.deleteFollowupActive(workItemId);
    }
  }

  const previousHistory = toMap(previous?.history ?? [], (record) => record.work_item_id);
  const nextHistoryIds = new Set<string>();
  for (let index = next.history.length - 1; index >= 0; index -= 1) {
    const record = next.history[index];
    nextHistoryIds.add(record.work_item_id);
    const prev = previousHistory.get(record.work_item_id);
    if (!prev || !jsonEqual(prev, record)) {
      store.upsertFollowupHistory(record);
    }
  }
  for (const workItemId of previousHistory.keys()) {
    if (!nextHistoryIds.has(workItemId)) {
      store.deleteFollowupHistory(workItemId);
    }
  }

  const previousSeenIds = previous?.seen_source_event_ids ?? [];
  const previousSeenSet = new Set(previousSeenIds);
  const previousPositions = new Map<string, number>();
  for (const [index, sourceEventId] of previousSeenIds.entries()) {
    previousPositions.set(sourceEventId, index);
  }

  const nextSeenIds = next.seen_source_event_ids;
  const nextSeenSet = new Set(nextSeenIds);
  const nowMs = Date.now();
  for (const [index, sourceEventId] of nextSeenIds.entries()) {
    const previousIndex = previousPositions.get(sourceEventId);
    if (typeof previousIndex === 'undefined' || index < previousIndex) {
      store.upsertSeenSourceEvent(sourceEventId, new Date(nowMs - index).toISOString());
    }
  }
  for (const sourceEventId of previousSeenSet) {
    if (!nextSeenSet.has(sourceEventId)) {
      store.deleteSeenSourceEvent(sourceEventId);
    }
  }

  store.trimFollowupHistory(maxEntries);
  store.trimSeenSourceEvents(seenSourceIdMaxEntries);
}

function normalizeClaimState(state: PersistedState, historyMaxEntries: number): PersistedState {
  return {
    version: state.version,
    started_at: state.started_at,
    total_claims: state.total_claims,
    last_github_sync_at: state.last_github_sync_at,
    active_claims: state.active_claims.map((claim) => structuredClone(claim)),
    history: state.history.slice(0, historyMaxEntries).map((claim) => structuredClone(claim)),
  };
}

function normalizeFollowupState(
  state: FollowupPersistedState,
  maxEntries: number,
  seenSourceIdMaxEntries: number,
): FollowupPersistedState {
  const seenIds: string[] = [];
  const seenSet = new Set<string>();
  for (const sourceEventId of state.seen_source_event_ids) {
    const normalized = sourceEventId.trim();
    if (!normalized || seenSet.has(normalized)) {
      continue;
    }
    seenSet.add(normalized);
    seenIds.push(normalized);
    if (seenIds.length >= seenSourceIdMaxEntries) {
      break;
    }
  }

  return {
    version: state.version,
    active_followups: state.active_followups.map((record) => structuredClone(record)),
    history: state.history.slice(0, maxEntries).map((record) => structuredClone(record)),
    seen_source_event_ids: seenIds,
  };
}

function toMap<T>(items: T[], keyFn: (item: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  for (const item of items) {
    out.set(keyFn(item), item);
  }

  return out;
}

function jsonEqual(left: ClaimRecord | PrFollowupRecord, right: ClaimRecord | PrFollowupRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
