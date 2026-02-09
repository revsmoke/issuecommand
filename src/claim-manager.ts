import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Logger } from './logger';
import {
  ClaimIncrementalPersistence,
  PersistenceDriver,
  isClaimIncrementalPersistence,
} from './state-persistence';
import {
  ClaimEvent,
  ClaimFilters,
  ClaimOperationResult,
  ClaimRecord,
  ClaimRequest,
  ClaimStatus,
  HistoryPage,
  PersistedState,
  SystemHealth,
  UpdateClaimStatusRequest,
  issueKey,
  isTerminalStatus,
} from './types';

interface ClaimManagerOptions {
  claimTimeoutMinutes: number;
  staleAutoReleaseMinutes: number;
  historyMaxEntries: number;
  persistence: PersistenceDriver<PersistedState>;
  logger: Logger;
  now?: () => Date;
}

const STATE_VERSION = 1;

const TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  claimed: ['in_progress', 'released', 'stale'],
  in_progress: ['pr_submitted', 'released', 'stale'],
  pr_submitted: ['pr_merged', 'released', 'stale'],
  pr_merged: ['closed', 'released', 'stale'],
  stale: ['in_progress', 'released'],
  closed: [],
  released: [],
};

export class ClaimManager {
  private readonly claimTimeoutMinutes: number;
  private readonly staleAutoReleaseMinutes: number;
  private readonly historyMaxEntries: number;
  private readonly persistence: PersistenceDriver<PersistedState>;
  private readonly incrementalPersistence?: ClaimIncrementalPersistence;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly events = new EventEmitter();
  private readonly activeClaims = new Map<string, ClaimRecord>();
  private readonly issueToClaimId = new Map<string, string>();
  private readonly history: ClaimRecord[] = [];
  private readonly lockQueues = new Map<string, Promise<void>>();
  private startedAt = new Date().toISOString();
  private totalClaims = 0;
  private lastGithubSyncAt?: string;

  constructor(options: ClaimManagerOptions) {
    this.claimTimeoutMinutes = options.claimTimeoutMinutes;
    this.staleAutoReleaseMinutes = options.staleAutoReleaseMinutes;
    this.historyMaxEntries = Math.max(0, options.historyMaxEntries);
    this.persistence = options.persistence;
    this.incrementalPersistence = isClaimIncrementalPersistence(options.persistence)
      ? options.persistence
      : undefined;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    const state = await this.persistence.load();
    if (!state) {
      this.logger.info('claims.initialized_empty');
      return;
    }

    this.hydrate(state);
    this.logger.info('claims.initialized_from_state', {
      active_claims: this.activeClaims.size,
      history_entries: this.history.length,
    });
  }

  onEvent(listener: (event: ClaimEvent) => void): () => void {
    this.events.on('claim_event', listener);
    return () => {
      this.events.off('claim_event', listener);
    };
  }

  isIssueClaimed(repo: string, issueNumber: number): boolean {
    return this.issueToClaimId.has(issueKey(repo, issueNumber));
  }

  getClaimById(claimId: string): ClaimRecord | undefined {
    const claim = this.activeClaims.get(claimId);
    return claim ? structuredClone(claim) : undefined;
  }

  getActiveClaims(filters: ClaimFilters = {}): ClaimRecord[] {
    const claims = [...this.activeClaims.values()].filter((claim) => this.matchesFilters(claim, filters));
    return claims.map((claim) => structuredClone(claim));
  }

  getHistory(limit = 50, cursor?: string, filters: ClaimFilters = {}): HistoryPage {
    const start = cursor ? Number.parseInt(cursor, 10) : 0;
    const safeStart = Number.isFinite(start) && start >= 0 ? start : 0;
    const safeLimit = Math.max(1, Math.min(200, limit));
    const filtered = this.history.filter((claim) => this.matchesFilters(claim, filters));

    const items = filtered.slice(safeStart, safeStart + safeLimit).map((claim) => structuredClone(claim));
    const nextCursor = safeStart + items.length < filtered.length ? String(safeStart + items.length) : undefined;

    return {
      items,
      next_cursor: nextCursor,
    };
  }

  getSystemHealth(): SystemHealth {
    const activeAgents = new Set<string>();
    let staleClaims = 0;

    for (const claim of this.activeClaims.values()) {
      activeAgents.add(claim.agent_id);
      if (claim.status === 'stale') {
        staleClaims += 1;
      }
    }

    return {
      uptime_seconds: Math.floor((this.now().getTime() - Date.parse(this.startedAt)) / 1000),
      total_claims: this.totalClaims,
      active_claims: this.activeClaims.size,
      active_agents: activeAgents.size,
      stale_claims: staleClaims,
      last_github_sync_at: this.lastGithubSyncAt,
    };
  }

  setLastGithubSyncAt(timestamp: string): void {
    this.lastGithubSyncAt = timestamp;
    this.persistClaimMutation((incremental) => {
      incremental.upsertClaimRuntime(this.getRuntimeMetadata());
    });
  }

  async claimIssue(request: ClaimRequest): Promise<ClaimOperationResult> {
    const lockKey = issueKey(request.repo, request.issue_number);

    return this.withIssueLock(lockKey, async () => {
      const existingClaimId = this.issueToClaimId.get(lockKey);
      if (existingClaimId) {
        const existingClaim = this.activeClaims.get(existingClaimId);
        if (!existingClaim) {
          this.issueToClaimId.delete(lockKey);
        } else if (existingClaim.agent_id === request.agent_id) {
          return {
            ok: true,
            idempotent: true,
            claim: structuredClone(existingClaim),
          };
        } else {
          return {
            ok: false,
            reason: 'already_claimed',
            message: `Issue ${request.repo}#${request.issue_number} is already claimed by ${existingClaim.agent_id}`,
            owner_agent_id: existingClaim.agent_id,
            claim: structuredClone(existingClaim),
          };
        }
      }

      const nowIso = this.now().toISOString();
      const claim: ClaimRecord = {
        claim_id: randomUUID(),
        agent_id: request.agent_id,
        repo: request.repo,
        issue_number: request.issue_number,
        issue_title: request.issue_title,
        issue_labels: request.issue_labels ?? [],
        issue_assignees: request.issue_assignees ?? [],
        status: 'claimed',
        claimed_at: nowIso,
        last_updated: nowIso,
        status_history: [
          {
            status: 'claimed',
            timestamp: nowIso,
          },
        ],
      };

      this.activeClaims.set(claim.claim_id, claim);
      this.issueToClaimId.set(lockKey, claim.claim_id);
      this.totalClaims += 1;
      this.emitClaimEvent('claim.created', claim, {
        idempotent: false,
      });
      this.logger.info('claim.created', {
        claim_id: claim.claim_id,
        repo: claim.repo,
        issue_number: claim.issue_number,
        agent_id: claim.agent_id,
      });
      this.persistClaimMutation((incremental) => {
        incremental.upsertActiveClaim(claim);
        incremental.upsertClaimRuntime(this.getRuntimeMetadata());
      });

      return {
        ok: true,
        idempotent: false,
        claim: structuredClone(claim),
      };
    });
  }

  async releaseIssue(request: {
    claim_id: string;
    agent_id?: string;
    reason?: string;
    source?: 'agent' | 'sync';
  }): Promise<ClaimOperationResult> {
    const claim = this.activeClaims.get(request.claim_id);
    if (!claim) {
      return {
        ok: false,
        reason: 'claim_not_found',
        message: `Claim ${request.claim_id} not found`,
      };
    }

    const lockKey = issueKey(claim.repo, claim.issue_number);

    return this.withIssueLock(lockKey, async () => {
      const freshClaim = this.activeClaims.get(request.claim_id);
      if (!freshClaim) {
        return {
          ok: false,
          reason: 'claim_not_found',
          message: `Claim ${request.claim_id} not found`,
        };
      }

      const source = request.source ?? 'agent';
      if (source === 'agent') {
        const agentId = request.agent_id?.trim();
        if (!agentId) {
          return {
            ok: false,
            reason: 'invalid_transition',
            message: 'agent_id is required for agent claim release',
          };
        }

        if (freshClaim.agent_id !== agentId) {
          return {
            ok: false,
            reason: 'agent_mismatch',
            message: `Claim ${request.claim_id} belongs to ${freshClaim.agent_id}`,
            owner_agent_id: freshClaim.agent_id,
            claim: structuredClone(freshClaim),
          };
        }
      }

      return this.applyTransitionLocked(freshClaim, {
        claim_id: request.claim_id,
        status: 'released',
        note: request.reason,
        source: request.source,
      });
    });
  }

  async updateClaimStatus(request: UpdateClaimStatusRequest): Promise<ClaimOperationResult> {
    const claim = this.activeClaims.get(request.claim_id);
    if (!claim) {
      return {
        ok: false,
        reason: 'claim_not_found',
        message: `Claim ${request.claim_id} not found`,
      };
    }

    const lockKey = issueKey(claim.repo, claim.issue_number);

    return this.withIssueLock(lockKey, async () => {
      const freshClaim = this.activeClaims.get(request.claim_id);
      if (!freshClaim) {
        return {
          ok: false,
          reason: 'claim_not_found',
          message: `Claim ${request.claim_id} not found`,
        };
      }

      const source = request.source ?? 'agent';
      if (source === 'agent') {
        const agentId = request.agent_id?.trim();
        if (!agentId) {
          return {
            ok: false,
            reason: 'invalid_transition',
            message: 'agent_id is required for agent claim status updates',
          };
        }

        if (freshClaim.agent_id !== agentId) {
          return {
            ok: false,
            reason: 'agent_mismatch',
            message: `Claim ${request.claim_id} belongs to ${freshClaim.agent_id}`,
            owner_agent_id: freshClaim.agent_id,
            claim: structuredClone(freshClaim),
          };
        }
      }

      return this.applyTransitionLocked(freshClaim, request);
    });
  }

  async reconcileIssueSnapshot(input: {
    repo: string;
    issue_number: number;
    title: string;
    labels: string[];
    assignees: string[];
    state: 'open' | 'closed';
  }): Promise<{ metadataUpdated: boolean; externallyClosed: boolean }> {
    const key = issueKey(input.repo, input.issue_number);
    const claimId = this.issueToClaimId.get(key);
    if (!claimId) {
      return {
        metadataUpdated: false,
        externallyClosed: false,
      };
    }

    return this.withIssueLock(key, async () => {
      const activeClaimId = this.issueToClaimId.get(key);
      if (!activeClaimId) {
        return {
          metadataUpdated: false,
          externallyClosed: false,
        };
      }

      const claim = this.activeClaims.get(activeClaimId);
      if (!claim) {
        this.issueToClaimId.delete(key);
        return {
          metadataUpdated: false,
          externallyClosed: false,
        };
      }

      let metadataUpdated = false;

      if (claim.issue_title !== input.title) {
        claim.issue_title = input.title;
        metadataUpdated = true;
      }

      const nextLabels = [...input.labels].sort();
      const nextAssignees = [...input.assignees].sort();
      if (!arrayEquals([...claim.issue_labels].sort(), nextLabels)) {
        claim.issue_labels = input.labels;
        metadataUpdated = true;
      }
      if (!arrayEquals([...claim.issue_assignees].sort(), nextAssignees)) {
        claim.issue_assignees = input.assignees;
        metadataUpdated = true;
      }

      if (metadataUpdated) {
        claim.last_updated = this.now().toISOString();
        this.persistClaimMutation((incremental) => {
          incremental.upsertActiveClaim(claim);
        });
      }

      if (input.state === 'closed') {
        const transitionResult = await this.applyTransitionLocked(claim, {
          claim_id: claim.claim_id,
          status: 'closed',
          source: 'sync',
          note: 'Closed externally on GitHub',
        });

        return {
          metadataUpdated,
          externallyClosed: transitionResult.ok,
        };
      }

      return {
        metadataUpdated,
        externallyClosed: false,
      };
    });
  }

  async runStaleSweep(): Promise<{ markedStale: number; autoReleased: number }> {
    const claims = [...this.activeClaims.values()];
    let markedStale = 0;
    let autoReleased = 0;

    for (const claim of claims) {
      const key = issueKey(claim.repo, claim.issue_number);
      await this.withIssueLock(key, async () => {
        const current = this.activeClaims.get(claim.claim_id);
        if (!current || isTerminalStatus(current.status)) {
          return;
        }

        const minutesSinceUpdate = minutesBetween(this.now(), current.last_updated);

        if (current.status !== 'stale' && minutesSinceUpdate >= this.claimTimeoutMinutes) {
          const staleResult = await this.applyTransitionLocked(current, {
            claim_id: current.claim_id,
            status: 'stale',
            source: 'sync',
            note: `No update in ${minutesSinceUpdate} minutes`,
          });

          if (staleResult.ok) {
            markedStale += 1;
          }
          return;
        }

        if (current.status !== 'stale' || this.staleAutoReleaseMinutes <= 0) {
          return;
        }

        const staleSince = [...current.status_history].reverse().find((entry) => entry.status === 'stale');
        if (!staleSince) {
          return;
        }

        const minutesSinceStale = minutesBetween(this.now(), staleSince.timestamp);
        if (minutesSinceStale < this.staleAutoReleaseMinutes) {
          return;
        }

        const releaseResult = await this.applyTransitionLocked(current, {
          claim_id: current.claim_id,
          status: 'released',
          source: 'sync',
          note: `Auto released after ${minutesSinceStale} minutes in stale state`,
        });

        if (releaseResult.ok) {
          autoReleased += 1;
        }
      });
    }

    if (markedStale || autoReleased) {
      this.logger.info('claim.stale_sweep_completed', {
        marked_stale: markedStale,
        auto_released: autoReleased,
      });
    }

    return {
      markedStale,
      autoReleased,
    };
  }

  private async applyTransitionLocked(
    claim: ClaimRecord,
    request: UpdateClaimStatusRequest,
  ): Promise<ClaimOperationResult> {
    const source = request.source ?? 'agent';

    if (request.status === claim.status) {
      return {
        ok: true,
        idempotent: true,
        claim: structuredClone(claim),
      };
    }

    if (request.status === 'pr_submitted' && !request.pr_url && !claim.pr_url) {
      return {
        ok: false,
        reason: 'invalid_transition',
        message: 'pr_url is required when transitioning to pr_submitted',
      };
    }

    if (!this.canTransition(claim.status, request.status, source)) {
      return {
        ok: false,
        reason: 'invalid_transition',
        message: `Cannot transition claim ${claim.claim_id} from ${claim.status} to ${request.status}`,
      };
    }

    const nowIso = this.now().toISOString();
    claim.status = request.status;
    claim.last_updated = nowIso;

    if (request.pr_url) {
      claim.pr_url = request.pr_url;
    }

    claim.status_history.push({
      status: request.status,
      timestamp: nowIso,
      note: request.note,
    });

    if (isTerminalStatus(claim.status)) {
      this.activeClaims.delete(claim.claim_id);
      this.issueToClaimId.delete(issueKey(claim.repo, claim.issue_number));
      this.history.unshift(structuredClone(claim));
      this.trimHistory();
    }

    const eventType = this.resolveEventType(request.status, source, request.note);
    this.emitClaimEvent(eventType, claim, {
      source,
      note: request.note,
    });

    this.logger.info('claim.updated', {
      claim_id: claim.claim_id,
      repo: claim.repo,
      issue_number: claim.issue_number,
      agent_id: claim.agent_id,
      status: claim.status,
      source,
    });

    this.persistClaimMutation((incremental) => {
      if (isTerminalStatus(claim.status)) {
        incremental.deleteActiveClaim(claim.claim_id);
        incremental.upsertClaimHistory(claim);
        incremental.trimClaimHistory(this.historyMaxEntries);
        return;
      }

      incremental.upsertActiveClaim(claim);
    });

    return {
      ok: true,
      idempotent: false,
      claim: structuredClone(claim),
    };
  }

  private resolveEventType(status: ClaimStatus, source: 'agent' | 'sync', note?: string): ClaimEvent['type'] {
    if (status === 'stale') {
      return 'claim.stale';
    }

    if (status === 'released') {
      if (source === 'sync' && note?.toLowerCase().includes('auto released')) {
        return 'claim.auto_released';
      }
      return 'claim.released';
    }

    return 'claim.updated';
  }

  private canTransition(
    currentStatus: ClaimStatus,
    nextStatus: ClaimStatus,
    source: 'agent' | 'sync',
  ): boolean {
    if (source === 'sync' && nextStatus === 'closed' && !isTerminalStatus(currentStatus)) {
      return true;
    }

    return TRANSITIONS[currentStatus].includes(nextStatus);
  }

  private emitClaimEvent(type: ClaimEvent['type'], claim: ClaimRecord, details?: Record<string, unknown>): void {
    const event: ClaimEvent = {
      event_id: randomUUID(),
      type,
      timestamp: this.now().toISOString(),
      claim_id: claim.claim_id,
      repo: claim.repo,
      issue_number: claim.issue_number,
      agent_id: claim.agent_id,
      details,
    };

    this.events.emit('claim_event', event);
  }

  private matchesFilters(claim: ClaimRecord, filters: ClaimFilters): boolean {
    if (filters.agent_id && claim.agent_id !== filters.agent_id) {
      return false;
    }
    if (filters.repo && claim.repo !== filters.repo) {
      return false;
    }
    if (filters.status && claim.status !== filters.status) {
      return false;
    }

    return true;
  }

  private hydrate(state: PersistedState): void {
    if (state.version !== STATE_VERSION) {
      this.logger.warn('state.version_mismatch', {
        expected: STATE_VERSION,
        received: state.version,
      });
    }

    this.activeClaims.clear();
    this.issueToClaimId.clear();
    this.history.length = 0;

    for (const claim of state.active_claims ?? []) {
      this.activeClaims.set(claim.claim_id, claim);
      this.issueToClaimId.set(issueKey(claim.repo, claim.issue_number), claim.claim_id);
    }

    for (const historicClaim of state.history ?? []) {
      this.history.push(historicClaim);
    }
    this.trimHistory();

    this.totalClaims = state.total_claims ?? state.active_claims?.length ?? 0;
    this.startedAt = state.started_at ?? this.startedAt;
    this.lastGithubSyncAt = state.last_github_sync_at;
  }

  private buildStateSnapshot(): PersistedState {
    return {
      version: STATE_VERSION,
      started_at: this.startedAt,
      total_claims: this.totalClaims,
      last_github_sync_at: this.lastGithubSyncAt,
      active_claims: [...this.activeClaims.values()].map((claim) => structuredClone(claim)),
      history: this.history.map((claim) => structuredClone(claim)),
    };
  }

  private getRuntimeMetadata(): {
    version: number;
    started_at: string;
    total_claims: number;
    last_github_sync_at?: string;
  } {
    return {
      version: STATE_VERSION,
      started_at: this.startedAt,
      total_claims: this.totalClaims,
      last_github_sync_at: this.lastGithubSyncAt,
    };
  }

  private persistClaimMutation(
    applyIncremental: (incremental: ClaimIncrementalPersistence) => void,
  ): void {
    if (this.incrementalPersistence) {
      this.incrementalPersistence.runClaimTransaction(() => {
        applyIncremental(this.incrementalPersistence!);
      });
      return;
    }

    this.persistence.scheduleSave(this.buildStateSnapshot());
  }

  private trimHistory(): void {
    if (this.history.length <= this.historyMaxEntries) {
      return;
    }

    this.history.length = this.historyMaxEntries;
  }

  private async withIssueLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.lockQueues.get(key) ?? Promise.resolve();

    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    const tail = previous.then(() => current);
    this.lockQueues.set(key, tail);

    await previous;

    try {
      return await fn();
    } finally {
      release();
      if (this.lockQueues.get(key) === tail) {
        this.lockQueues.delete(key);
      }
    }
  }
}

function minutesBetween(now: Date, isoTimestamp: string): number {
  const elapsedMs = now.getTime() - Date.parse(isoTimestamp);
  return Math.max(0, Math.floor(elapsedMs / 60000));
}

function arrayEquals(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}
