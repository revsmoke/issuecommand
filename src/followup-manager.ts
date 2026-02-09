import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Logger } from './logger';
import {
  FollowupIncrementalPersistence,
  PersistenceDriver,
  isFollowupIncrementalPersistence,
} from './state-persistence';
import {
  ClaimEvent,
  FollowupFilters,
  FollowupOperationResult,
  FollowupPersistedState,
  FollowupSourceEventType,
  FollowupStatus,
  FollowupHistoryPage,
  PrFollowupRecord,
} from './types';

interface FollowupManagerOptions {
  persistence: PersistenceDriver<FollowupPersistedState>;
  logger: Logger;
  maxEntries: number;
  staleMinutes: number;
  seenSourceIdMaxEntries?: number;
  now?: () => Date;
}

interface CreateFollowupInput {
  repo: string;
  pr_number: number;
  pr_url: string;
  pr_title: string;
  source_event_type: FollowupSourceEventType;
  source_event_id: string;
  source_delivery_id?: string;
  requested_by?: string;
  summary: string;
  actionable_comments: string[];
}

interface UpdateFollowupStatusInput {
  work_item_id: string;
  status: FollowupStatus;
  note?: string;
  agent_id?: string;
  source?: 'agent' | 'webhook' | 'sync';
}

const FOLLOWUP_STATE_VERSION = 1;
const DEFAULT_SEEN_SOURCE_EVENT_CAP = 20_000;

const FOLLOWUP_TRANSITIONS: Record<FollowupStatus, FollowupStatus[]> = {
  queued: ['claimed', 'in_progress', 'done', 'dismissed', 'stale'],
  claimed: ['in_progress', 'done', 'dismissed', 'stale'],
  in_progress: ['done', 'dismissed', 'stale'],
  stale: ['claimed', 'in_progress', 'done', 'dismissed'],
  done: [],
  dismissed: [],
};

export class FollowupManager {
  private readonly persistence: PersistenceDriver<FollowupPersistedState>;
  private readonly incrementalPersistence?: FollowupIncrementalPersistence;
  private readonly logger: Logger;
  private readonly maxEntries: number;
  private readonly staleMinutes: number;
  private readonly seenSourceIdMaxEntries: number;
  private readonly now: () => Date;
  private readonly events = new EventEmitter();
  private readonly active = new Map<string, PrFollowupRecord>();
  private readonly history: PrFollowupRecord[] = [];
  private readonly sourceEventToWorkItemId = new Map<string, string>();
  private readonly seenSourceEventIds: string[] = [];
  private readonly issueLocks = new Map<string, Promise<void>>();

  constructor(options: FollowupManagerOptions) {
    this.persistence = options.persistence;
    this.incrementalPersistence = isFollowupIncrementalPersistence(options.persistence)
      ? options.persistence
      : undefined;
    this.logger = options.logger;
    this.maxEntries = Math.max(0, options.maxEntries);
    this.staleMinutes = Math.max(1, options.staleMinutes);
    this.seenSourceIdMaxEntries = Math.max(10, options.seenSourceIdMaxEntries ?? DEFAULT_SEEN_SOURCE_EVENT_CAP);
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    const state = await this.persistence.load();
    if (!state) {
      this.logger.info('followups.initialized_empty');
      return;
    }

    this.hydrate(state);
    this.logger.info('followups.initialized_from_state', {
      active_followups: this.active.size,
      history_entries: this.history.length,
    });
  }

  onEvent(listener: (event: ClaimEvent) => void): () => void {
    this.events.on('followup_event', listener);
    return () => {
      this.events.off('followup_event', listener);
    };
  }

  listFollowups(filters: FollowupFilters = {}): PrFollowupRecord[] {
    return [...this.active.values()]
      .filter((record) => matchesFilters(record, filters))
      .sort((left, right) => scorePriority(left) - scorePriority(right) || Date.parse(left.created_at) - Date.parse(right.created_at))
      .map((record) => structuredClone(record));
  }

  getHistory(limit = 50, cursor?: string, filters: FollowupFilters = {}): FollowupHistoryPage {
    const start = cursor ? Number.parseInt(cursor, 10) : 0;
    const safeStart = Number.isFinite(start) && start >= 0 ? start : 0;
    const safeLimit = Math.max(1, Math.min(200, limit));
    const filtered = this.history.filter((record) => matchesFilters(record, filters));
    const items = filtered.slice(safeStart, safeStart + safeLimit).map((record) => structuredClone(record));

    return {
      items,
      next_cursor: safeStart + items.length < filtered.length ? String(safeStart + items.length) : undefined,
    };
  }

  getMyFollowups(agentId: string): PrFollowupRecord[] {
    return [...this.active.values()]
      .filter((record) => record.claimed_by_agent_id === agentId)
      .map((record) => structuredClone(record));
  }

  getFollowupById(workItemId: string): PrFollowupRecord | undefined {
    const record = this.active.get(workItemId);
    return record ? structuredClone(record) : undefined;
  }

  async createFromWebhook(input: CreateFollowupInput): Promise<FollowupOperationResult> {
    const lockKey = `${input.repo}#${input.pr_number}`;

    return this.withIssueLock(lockKey, async () => {
      const existingWorkItemId = this.sourceEventToWorkItemId.get(input.source_event_id);
      if (existingWorkItemId) {
        const existing = this.active.get(existingWorkItemId) ?? this.history.find((item) => item.work_item_id === existingWorkItemId);
        return {
          ok: true,
          idempotent: true,
          work_item: existing ? structuredClone(existing) : undefined,
        };
      }

      if (this.hasSeenSourceEventId(input.source_event_id)) {
        const existing =
          [...this.active.values()].find((item) => item.source_event_id === input.source_event_id) ??
          this.history.find((item) => item.source_event_id === input.source_event_id);
        return {
          ok: true,
          idempotent: true,
          work_item: existing ? structuredClone(existing) : undefined,
        };
      }

      const nowIso = this.now().toISOString();
      const summary = input.summary.trim() || `${input.source_event_type} for PR #${input.pr_number}`;
      const workItem: PrFollowupRecord = {
        work_item_id: randomUUID(),
        repo: input.repo,
        pr_number: input.pr_number,
        pr_url: input.pr_url,
        pr_title: input.pr_title,
        source_event_type: input.source_event_type,
        source_event_id: input.source_event_id,
        source_delivery_id: input.source_delivery_id,
        requested_by: input.requested_by,
        summary,
        actionable_comments: input.actionable_comments.filter(Boolean),
        status: 'queued',
        created_at: nowIso,
        last_updated: nowIso,
        status_history: [
          {
            status: 'queued',
            timestamp: nowIso,
            note: 'Created from webhook event',
          },
        ],
      };

      this.active.set(workItem.work_item_id, workItem);
      this.sourceEventToWorkItemId.set(input.source_event_id, workItem.work_item_id);
      const removedSeenSourceIds = this.addSeenSourceEventId(input.source_event_id);

      this.emitEvent('followup.created', workItem, {
        source_event_type: input.source_event_type,
        source_event_id: input.source_event_id,
      });

      this.logger.info('followup.created', {
        work_item_id: workItem.work_item_id,
        repo: workItem.repo,
        pr_number: workItem.pr_number,
        source_event_type: workItem.source_event_type,
      });

      this.persistFollowupMutation((incremental) => {
        incremental.upsertFollowupRuntime(FOLLOWUP_STATE_VERSION);
        incremental.upsertActiveFollowup(workItem);
        incremental.upsertSeenSourceEvent(input.source_event_id, nowIso);
        for (const removedSourceId of removedSeenSourceIds) {
          incremental.deleteSeenSourceEvent(removedSourceId);
        }
        incremental.trimSeenSourceEvents(this.seenSourceIdMaxEntries);
      });

      return {
        ok: true,
        idempotent: false,
        work_item: structuredClone(workItem),
      };
    });
  }

  async claimNextFollowup(agentId: string, repo?: string): Promise<FollowupOperationResult> {
    const candidates = [...this.active.values()]
      .filter((record) => {
        if (repo && record.repo !== repo) {
          return false;
        }

        return record.status === 'queued' || record.status === 'stale';
      })
      .sort((left, right) => scorePriority(left) - scorePriority(right) || Date.parse(left.created_at) - Date.parse(right.created_at));

    if (candidates.length === 0) {
      return {
        ok: false,
        reason: 'no_followup_available',
        message: 'No queued PR follow-up work is currently available',
      };
    }

    for (const candidate of candidates) {
      const lockKey = `${candidate.repo}#${candidate.pr_number}`;
      const result = await this.withIssueLock(lockKey, async () => {
        const current = this.active.get(candidate.work_item_id);
        if (!current) {
          return undefined;
        }

        if (current.status !== 'queued' && current.status !== 'stale') {
          return undefined;
        }

        const nowIso = this.now().toISOString();
        current.status = 'claimed';
        current.claimed_by_agent_id = agentId;
        current.claimed_at = nowIso;
        current.last_updated = nowIso;
        current.status_history.push({
          status: 'claimed',
          timestamp: nowIso,
          note: `Claimed by ${agentId}`,
        });

        this.emitEvent('followup.claimed', current, {
          claimed_by_agent_id: agentId,
        });

        this.logger.info('followup.claimed', {
          work_item_id: current.work_item_id,
          repo: current.repo,
          pr_number: current.pr_number,
          agent_id: agentId,
        });

        this.persistFollowupMutation((incremental) => {
          incremental.upsertActiveFollowup(current);
        });

        return {
          ok: true,
          work_item: structuredClone(current),
        } satisfies FollowupOperationResult;
      });

      if (result) {
        return result;
      }
    }

    return {
      ok: false,
      reason: 'no_followup_available',
      message: 'All queued PR follow-up work was claimed concurrently',
    };
  }

  async updateFollowupStatus(input: UpdateFollowupStatusInput): Promise<FollowupOperationResult> {
    const current = this.active.get(input.work_item_id);
    if (!current) {
      return {
        ok: false,
        reason: 'not_found',
        message: `Follow-up ${input.work_item_id} not found`,
      };
    }

    const lockKey = `${current.repo}#${current.pr_number}`;
    return this.withIssueLock(lockKey, async () => {
      const record = this.active.get(input.work_item_id);
      if (!record) {
        return {
          ok: false,
          reason: 'not_found',
          message: `Follow-up ${input.work_item_id} not found`,
        };
      }

      return this.applyStatusTransition(record, input);
    });
  }

  async resolveBySynchronize(input: {
    repo: string;
    pr_number: number;
    source_event_id: string;
    source_delivery_id?: string;
  }): Promise<number> {
    const lockKey = `${input.repo}#${input.pr_number}`;

    return this.withIssueLock(lockKey, async () => {
      const nowIso = this.now().toISOString();
      const removedSeenSourceIds = this.addSeenSourceEventId(input.source_event_id);
      this.persistFollowupMutation((incremental) => {
        incremental.upsertFollowupRuntime(FOLLOWUP_STATE_VERSION);
        incremental.upsertSeenSourceEvent(input.source_event_id, nowIso);
        for (const removedSourceId of removedSeenSourceIds) {
          incremental.deleteSeenSourceEvent(removedSourceId);
        }
        incremental.trimSeenSourceEvents(this.seenSourceIdMaxEntries);
      });

      const candidates = [...this.active.values()].filter(
        (record) =>
          record.repo === input.repo &&
          record.pr_number === input.pr_number &&
          record.status !== 'done' &&
          record.status !== 'dismissed',
      );

      let resolved = 0;
      for (const record of candidates) {
        const transition = this.applyStatusTransition(record, {
          work_item_id: record.work_item_id,
          status: 'done',
          note: 'Resolved by new commit pushed to PR branch',
          source: 'webhook',
        });

        if (transition.ok) {
          resolved += 1;
        }
      }

      if (resolved > 0) {
        this.logger.info('followup.resolved_by_synchronize', {
          repo: input.repo,
          pr_number: input.pr_number,
          resolved,
          source_delivery_id: input.source_delivery_id,
        });
      }

      return resolved;
    });
  }

  async runStaleSweep(): Promise<{ markedStale: number }> {
    const followups = [...this.active.values()];
    let markedStale = 0;

    for (const followup of followups) {
      const lockKey = `${followup.repo}#${followup.pr_number}`;
      await this.withIssueLock(lockKey, async () => {
        const current = this.active.get(followup.work_item_id);
        if (!current) {
          return;
        }

        if (current.status === 'done' || current.status === 'dismissed' || current.status === 'stale') {
          return;
        }

        const minutesSinceUpdate = minutesBetween(this.now(), current.last_updated);
        if (minutesSinceUpdate < this.staleMinutes) {
          return;
        }

        const result = this.applyStatusTransition(current, {
          work_item_id: current.work_item_id,
          status: 'stale',
          note: `No update in ${minutesSinceUpdate} minutes`,
          source: 'sync',
        });

        if (result.ok) {
          markedStale += 1;
        }
      });
    }

    return {
      markedStale,
    };
  }

  hasSeenSourceEventId(sourceEventId: string): boolean {
    return this.sourceEventToWorkItemId.has(sourceEventId) || this.seenSourceEventIds.includes(sourceEventId);
  }

  private applyStatusTransition(record: PrFollowupRecord, input: UpdateFollowupStatusInput): FollowupOperationResult {
    const source = input.source ?? 'agent';
    const agentId = input.agent_id?.trim();

    if (record.status === input.status) {
      return {
        ok: true,
        idempotent: true,
        work_item: structuredClone(record),
      };
    }

    if (!FOLLOWUP_TRANSITIONS[record.status].includes(input.status)) {
      return {
        ok: false,
        reason: 'invalid_transition',
        message: `Cannot transition follow-up ${record.work_item_id} from ${record.status} to ${input.status}`,
      };
    }

    if (source === 'agent') {
      if (!agentId) {
        return {
          ok: false,
          reason: 'invalid_transition',
          message: 'agent_id is required for agent follow-up status updates',
        };
      }

      if (record.claimed_by_agent_id && agentId !== record.claimed_by_agent_id) {
        return {
          ok: false,
          reason: 'agent_mismatch',
          message: `Follow-up ${record.work_item_id} belongs to ${record.claimed_by_agent_id}`,
          owner_agent_id: record.claimed_by_agent_id,
        };
      }

      const isInitialClaimingStatus = input.status === 'claimed' || input.status === 'in_progress';
      if (!record.claimed_by_agent_id && !isInitialClaimingStatus) {
        return {
          ok: false,
          reason: 'invalid_transition',
          message: `Follow-up ${record.work_item_id} must be claimed before setting status to ${input.status}`,
        };
      }
    }

    const nowIso = this.now().toISOString();
    record.status = input.status;
    record.last_updated = nowIso;

    if (source === 'agent' && agentId && !record.claimed_by_agent_id && (input.status === 'claimed' || input.status === 'in_progress')) {
      record.claimed_by_agent_id = agentId;
      record.claimed_at = nowIso;
    }

    if (input.status === 'done') {
      record.done_at = nowIso;
    }

    if (input.status === 'dismissed') {
      record.dismiss_reason = input.note;
    }

    record.status_history.push({
      status: input.status,
      timestamp: nowIso,
      note: input.note,
    });

    if (input.status === 'done' || input.status === 'dismissed') {
      this.active.delete(record.work_item_id);
      this.history.unshift(structuredClone(record));
      this.trimHistory();
    }

    const eventType = resolveFollowupEventType(input.status);
    this.emitEvent(eventType, record, {
      source,
      note: input.note,
    });

    this.logger.info('followup.updated', {
      work_item_id: record.work_item_id,
      repo: record.repo,
      pr_number: record.pr_number,
      status: record.status,
      source,
    });

    this.persistFollowupMutation((incremental) => {
      if (input.status === 'done' || input.status === 'dismissed') {
        incremental.deleteActiveFollowup(record.work_item_id);
        incremental.upsertFollowupHistory(record);
        incremental.trimFollowupHistory(this.maxEntries);
        return;
      }

      incremental.upsertActiveFollowup(record);
    });

    return {
      ok: true,
      idempotent: false,
      work_item: structuredClone(record),
    };
  }

  private emitEvent(type: ClaimEvent['type'], record: PrFollowupRecord, details?: Record<string, unknown>): void {
    const event: ClaimEvent = {
      event_id: randomUUID(),
      type,
      timestamp: this.now().toISOString(),
      work_item_id: record.work_item_id,
      repo: record.repo,
      pr_number: record.pr_number,
      agent_id: record.claimed_by_agent_id,
      details,
    };

    this.events.emit('followup_event', event);
  }

  private hydrate(state: FollowupPersistedState): void {
    this.active.clear();
    this.history.length = 0;
    this.sourceEventToWorkItemId.clear();
    this.seenSourceEventIds.length = 0;

    for (const record of state.active_followups ?? []) {
      this.active.set(record.work_item_id, record);
      this.sourceEventToWorkItemId.set(record.source_event_id, record.work_item_id);
    }

    for (const record of state.history ?? []) {
      this.history.push(record);
    }
    this.trimHistory();

    for (const record of this.history) {
      if (!this.sourceEventToWorkItemId.has(record.source_event_id)) {
        this.sourceEventToWorkItemId.set(record.source_event_id, record.work_item_id);
      }
    }

    for (const sourceId of state.seen_source_event_ids ?? []) {
      if (!sourceId) {
        continue;
      }
      this.seenSourceEventIds.push(sourceId);
    }

    for (const item of this.active.values()) {
      this.addSeenSourceEventId(item.source_event_id);
    }

    for (const item of this.history) {
      this.addSeenSourceEventId(item.source_event_id);
    }
  }

  private buildStateSnapshot(): FollowupPersistedState {
    return {
      version: FOLLOWUP_STATE_VERSION,
      active_followups: [...this.active.values()].map((record) => structuredClone(record)),
      history: this.history.map((record) => structuredClone(record)),
      seen_source_event_ids: [...this.seenSourceEventIds],
    };
  }

  private trimHistory(): void {
    if (this.history.length <= this.maxEntries) {
      return;
    }

    const removed = this.history.splice(this.maxEntries);
    for (const record of removed) {
      const mappedWorkItemId = this.sourceEventToWorkItemId.get(record.source_event_id);
      if (mappedWorkItemId === record.work_item_id) {
        this.sourceEventToWorkItemId.delete(record.source_event_id);
      }
    }
  }

  private addSeenSourceEventId(sourceEventId: string): string[] {
    if (!sourceEventId) {
      return [];
    }

    const existingIndex = this.seenSourceEventIds.indexOf(sourceEventId);
    if (existingIndex >= 0) {
      this.seenSourceEventIds.splice(existingIndex, 1);
    }

    this.seenSourceEventIds.unshift(sourceEventId);
    const removed: string[] = [];
    if (this.seenSourceEventIds.length > this.seenSourceIdMaxEntries) {
      removed.push(...this.seenSourceEventIds.splice(this.seenSourceIdMaxEntries));
    }

    return removed;
  }

  private persistFollowupMutation(
    applyIncremental: (incremental: FollowupIncrementalPersistence) => void,
  ): void {
    if (this.incrementalPersistence) {
      this.incrementalPersistence.runFollowupTransaction(() => {
        applyIncremental(this.incrementalPersistence!);
      });
      return;
    }

    this.persistence.scheduleSave(this.buildStateSnapshot());
  }

  private async withIssueLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.issueLocks.get(key) ?? Promise.resolve();

    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    const tail = previous.then(() => current);
    this.issueLocks.set(key, tail);

    await previous;

    try {
      return await fn();
    } finally {
      release();
      if (this.issueLocks.get(key) === tail) {
        this.issueLocks.delete(key);
      }
    }
  }
}

function resolveFollowupEventType(status: FollowupStatus): ClaimEvent['type'] {
  if (status === 'done') {
    return 'followup.done';
  }

  if (status === 'dismissed') {
    return 'followup.dismissed';
  }

  if (status === 'stale') {
    return 'followup.stale';
  }

  return 'followup.updated';
}

function scorePriority(record: PrFollowupRecord): number {
  switch (record.source_event_type) {
    case 'review_changes_requested':
      return 0;
    case 'review_comment':
      return 1;
    case 'pr_comment':
      return 2;
    default:
      return 3;
  }
}

function matchesFilters(record: PrFollowupRecord, filters: FollowupFilters): boolean {
  if (filters.repo && filters.repo !== record.repo) {
    return false;
  }

  if (filters.status && filters.status !== record.status) {
    return false;
  }

  if (filters.claimed_by_agent_id && filters.claimed_by_agent_id !== record.claimed_by_agent_id) {
    return false;
  }

  if (typeof filters.pr_number === 'number' && filters.pr_number !== record.pr_number) {
    return false;
  }

  return true;
}

function minutesBetween(now: Date, isoTimestamp: string): number {
  const elapsedMs = now.getTime() - Date.parse(isoTimestamp);
  return Math.max(0, Math.floor(elapsedMs / 60000));
}
