import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Logger } from '../logger';
import type { ClaimRecord, FollowupPersistedState, PersistedState, PrFollowupRecord } from '../types';

interface SqliteStoreOptions {
  filePath: string;
  logger: Logger;
  busyTimeoutMs: number;
  journalMode: string;
  webhookDedupeMaxEntries?: number;
}

const CLAIMS_NAMESPACE = 'claims_state';
const FOLLOWUPS_NAMESPACE = 'followups_state';
const DEFAULT_WEBHOOK_DEDUPE_MAX = 20_000;
const CLAIM_STATE_ROW_ID = 1;
const FOLLOWUP_STATE_ROW_ID = 1;
const ALLOWED_JOURNAL_MODES = new Set([
  'DELETE',
  'TRUNCATE',
  'PERSIST',
  'MEMORY',
  'WAL',
  'OFF',
]);

export class SqliteStore {
  readonly filePath: string;
  private readonly logger: Logger;
  private readonly busyTimeoutMs: number;
  private readonly journalMode: string;
  private readonly webhookDedupeMaxEntries: number;
  private db?: Database;

  constructor(options: SqliteStoreOptions) {
    this.filePath = resolve(options.filePath);
    this.logger = options.logger;
    this.busyTimeoutMs = Math.max(0, options.busyTimeoutMs);
    this.journalMode = normalizeJournalMode(options.journalMode);
    this.webhookDedupeMaxEntries = Math.max(100, options.webhookDedupeMaxEntries ?? DEFAULT_WEBHOOK_DEDUPE_MAX);
  }

  async initialize(): Promise<void> {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const db = new Database(this.filePath, { create: true, strict: true });
    db.exec(`PRAGMA journal_mode = ${this.journalMode};`);
    db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
    db.exec('PRAGMA foreign_keys = ON;');

    db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        namespace TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS claim_runtime_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        total_claims INTEGER NOT NULL,
        last_github_sync_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS claim_active (
        claim_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        last_updated TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_claim_active_repo_issue
      ON claim_active (repo, issue_number);

      CREATE TABLE IF NOT EXISTS claim_history (
        history_index INTEGER PRIMARY KEY AUTOINCREMENT,
        claim_id TEXT NOT NULL UNIQUE,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        last_updated TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_claim_history_order
      ON claim_history (history_index DESC);

      CREATE TABLE IF NOT EXISTS followup_runtime_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS followup_active (
        work_item_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        source_event_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        last_updated TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_followup_active_repo_pr
      ON followup_active (repo, pr_number);

      CREATE TABLE IF NOT EXISTS followup_history (
        history_index INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id TEXT NOT NULL UNIQUE,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        source_event_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        last_updated TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_followup_history_order
      ON followup_history (history_index DESC);

      CREATE TABLE IF NOT EXISTS followup_seen_source_events (
        source_event_id TEXT PRIMARY KEY,
        seen_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_followup_seen_source_events_seen_at
      ON followup_seen_source_events (seen_at DESC);

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        seen_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_seen_at
      ON webhook_deliveries (seen_at DESC);
    `);

    this.db = db;
    this.logger.info('sqlite.initialized', {
      file_path: this.filePath,
      journal_mode: this.journalMode,
      busy_timeout_ms: this.busyTimeoutMs,
    });
  }

  hasAnyStateSnapshot(): boolean {
    const db = this.getDb();
    const row = db
      .query(
        `
          SELECT COUNT(*) as count
          FROM snapshots
          WHERE namespace IN (?, ?)
        `,
      )
      .get(CLAIMS_NAMESPACE, FOLLOWUPS_NAMESPACE) as { count: number } | null;
    return Number(row?.count ?? 0) > 0;
  }

  hasAnyClaimState(): boolean {
    const db = this.getDb();
    const runtime = db
      .query(
        `
          SELECT COUNT(*) as count
          FROM claim_runtime_state
          WHERE id = ?
        `,
      )
      .get(CLAIM_STATE_ROW_ID) as { count: number } | null;
    if (Number(runtime?.count ?? 0) > 0) {
      return true;
    }

    const active = db
      .query(
        `
          SELECT COUNT(*) as count
          FROM claim_active
        `,
      )
      .get() as { count: number } | null;
    if (Number(active?.count ?? 0) > 0) {
      return true;
    }

    const history = db
      .query(
        `
          SELECT COUNT(*) as count
          FROM claim_history
        `,
      )
      .get() as { count: number } | null;
    return Number(history?.count ?? 0) > 0;
  }

  hasAnyFollowupState(): boolean {
    const db = this.getDb();
    const runtime = db
      .query(
        `
          SELECT COUNT(*) as count
          FROM followup_runtime_state
          WHERE id = ?
        `,
      )
      .get(FOLLOWUP_STATE_ROW_ID) as { count: number } | null;
    if (Number(runtime?.count ?? 0) > 0) {
      return true;
    }

    const active = db
      .query(
        `
          SELECT COUNT(*) as count
          FROM followup_active
        `,
      )
      .get() as { count: number } | null;
    if (Number(active?.count ?? 0) > 0) {
      return true;
    }

    const history = db
      .query(
        `
          SELECT COUNT(*) as count
          FROM followup_history
        `,
      )
      .get() as { count: number } | null;
    if (Number(history?.count ?? 0) > 0) {
      return true;
    }

    const seen = db
      .query(
        `
          SELECT COUNT(*) as count
          FROM followup_seen_source_events
        `,
      )
      .get() as { count: number } | null;
    return Number(seen?.count ?? 0) > 0;
  }

  hasSnapshot(namespace: string): boolean {
    const db = this.getDb();
    const row = db
      .query(
        `
          SELECT COUNT(*) as count
          FROM snapshots
          WHERE namespace = ?
        `,
      )
      .get(namespace) as { count: number } | null;

    return Number(row?.count ?? 0) > 0;
  }

  loadSnapshot<T>(namespace: string): T | null {
    const db = this.getDb();
    const row = db
      .query(
        `
          SELECT payload_json
          FROM snapshots
          WHERE namespace = ?
        `,
      )
      .get(namespace) as { payload_json: string } | null;

    if (!row?.payload_json) {
      return null;
    }

    const parsed = JSON.parse(row.payload_json) as T;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Snapshot ${namespace} has invalid payload`);
    }
    return parsed;
  }

  saveSnapshot(namespace: string, payload: unknown): void {
    const db = this.getDb();
    const payloadJson = JSON.stringify(payload);
    const nowIso = new Date().toISOString();

    db.prepare(
      `
        INSERT INTO snapshots (namespace, payload_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(namespace) DO UPDATE SET
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `,
    ).run(namespace, payloadJson, nowIso);
  }

  loadClaimState(): PersistedState | null {
    const db = this.getDb();
    const runtime = db
      .query(
        `
          SELECT version, started_at, total_claims, last_github_sync_at
          FROM claim_runtime_state
          WHERE id = ?
        `,
      )
      .get(CLAIM_STATE_ROW_ID) as
      | {
          version: number;
          started_at: string;
          total_claims: number;
          last_github_sync_at: string | null;
        }
      | null;

    const activeRows = db
      .query(
        `
          SELECT payload_json
          FROM claim_active
        `,
      )
      .all() as Array<{ payload_json: string }>;
    const historyRows = db
      .query(
        `
          SELECT payload_json
          FROM claim_history
          ORDER BY history_index DESC
        `,
      )
      .all() as Array<{ payload_json: string }>;

    if (!runtime && activeRows.length === 0 && historyRows.length === 0) {
      return null;
    }

    const activeClaims = activeRows.map((row) => parsePayload<ClaimRecord>(row.payload_json, 'claim_active'));
    const history = historyRows.map((row) => parsePayload<ClaimRecord>(row.payload_json, 'claim_history'));

    return {
      version: runtime?.version ?? 1,
      started_at: runtime?.started_at ?? new Date().toISOString(),
      total_claims: runtime?.total_claims ?? activeClaims.length + history.length,
      last_github_sync_at: runtime?.last_github_sync_at ?? undefined,
      active_claims: activeClaims,
      history,
    };
  }

  loadFollowupState(): FollowupPersistedState | null {
    const db = this.getDb();
    const runtime = db
      .query(
        `
          SELECT version
          FROM followup_runtime_state
          WHERE id = ?
        `,
      )
      .get(FOLLOWUP_STATE_ROW_ID) as { version: number } | null;

    const activeRows = db
      .query(
        `
          SELECT payload_json
          FROM followup_active
        `,
      )
      .all() as Array<{ payload_json: string }>;
    const historyRows = db
      .query(
        `
          SELECT payload_json
          FROM followup_history
          ORDER BY history_index DESC
        `,
      )
      .all() as Array<{ payload_json: string }>;
    const seenRows = db
      .query(
        `
          SELECT source_event_id
          FROM followup_seen_source_events
          ORDER BY seen_at DESC
        `,
      )
      .all() as Array<{ source_event_id: string }>;

    if (!runtime && activeRows.length === 0 && historyRows.length === 0 && seenRows.length === 0) {
      return null;
    }

    return {
      version: runtime?.version ?? 1,
      active_followups: activeRows.map((row) =>
        parsePayload<PrFollowupRecord>(row.payload_json, 'followup_active'),
      ),
      history: historyRows.map((row) => parsePayload<PrFollowupRecord>(row.payload_json, 'followup_history')),
      seen_source_event_ids: seenRows
        .map((row) => row.source_event_id.trim())
        .filter((sourceEventId) => sourceEventId.length > 0),
    };
  }

  runInTransaction(fn: () => void): void {
    const db = this.getDb();
    const transaction = db.transaction(fn);
    transaction();
  }

  upsertClaimRuntimeState(input: {
    version: number;
    startedAt: string;
    totalClaims: number;
    lastGithubSyncAt?: string;
  }): void {
    const db = this.getDb();
    const nowIso = new Date().toISOString();
    db.prepare(
      `
        INSERT INTO claim_runtime_state (
          id,
          version,
          started_at,
          total_claims,
          last_github_sync_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          version = excluded.version,
          started_at = excluded.started_at,
          total_claims = excluded.total_claims,
          last_github_sync_at = excluded.last_github_sync_at,
          updated_at = excluded.updated_at
      `,
    ).run(
      CLAIM_STATE_ROW_ID,
      input.version,
      input.startedAt,
      input.totalClaims,
      input.lastGithubSyncAt ?? null,
      nowIso,
    );
  }

  upsertClaimActive(claim: ClaimRecord): void {
    const db = this.getDb();
    db.prepare(
      `
        INSERT INTO claim_active (
          claim_id,
          repo,
          issue_number,
          agent_id,
          last_updated,
          payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(claim_id) DO UPDATE SET
          repo = excluded.repo,
          issue_number = excluded.issue_number,
          agent_id = excluded.agent_id,
          last_updated = excluded.last_updated,
          payload_json = excluded.payload_json
      `,
    ).run(
      claim.claim_id,
      claim.repo,
      claim.issue_number,
      claim.agent_id,
      claim.last_updated,
      JSON.stringify(claim),
    );
  }

  deleteClaimActive(claimId: string): void {
    const db = this.getDb();
    db.prepare(
      `
        DELETE FROM claim_active
        WHERE claim_id = ?
      `,
    ).run(claimId);
  }

  upsertClaimHistory(claim: ClaimRecord): void {
    const db = this.getDb();
    db.prepare(
      `
        INSERT INTO claim_history (
          claim_id,
          repo,
          issue_number,
          agent_id,
          last_updated,
          payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(claim_id) DO UPDATE SET
          repo = excluded.repo,
          issue_number = excluded.issue_number,
          agent_id = excluded.agent_id,
          last_updated = excluded.last_updated,
          payload_json = excluded.payload_json
      `,
    ).run(
      claim.claim_id,
      claim.repo,
      claim.issue_number,
      claim.agent_id,
      claim.last_updated,
      JSON.stringify(claim),
    );
  }

  deleteClaimHistory(claimId: string): void {
    const db = this.getDb();
    db.prepare(
      `
        DELETE FROM claim_history
        WHERE claim_id = ?
      `,
    ).run(claimId);
  }

  trimClaimHistory(maxEntries: number): void {
    const normalizedMax = Math.max(0, maxEntries);
    const db = this.getDb();
    db.prepare(
      `
        DELETE FROM claim_history
        WHERE history_index IN (
          SELECT history_index
          FROM claim_history
          ORDER BY history_index DESC
          LIMIT -1 OFFSET ?
        )
      `,
    ).run(normalizedMax);
  }

  clearClaimState(): void {
    const db = this.getDb();
    db.exec(`
      DELETE FROM claim_active;
      DELETE FROM claim_history;
      DELETE FROM claim_runtime_state WHERE id = ${CLAIM_STATE_ROW_ID};
    `);
  }

  replaceClaimState(state: PersistedState, historyMaxEntries: number): void {
    this.runInTransaction(() => {
      this.clearClaimState();
      this.upsertClaimRuntimeState({
        version: state.version,
        startedAt: state.started_at,
        totalClaims: state.total_claims,
        lastGithubSyncAt: state.last_github_sync_at,
      });

      for (const claim of state.active_claims ?? []) {
        this.upsertClaimActive(claim);
      }

      const history = (state.history ?? []).slice(0, Math.max(0, historyMaxEntries));
      for (let index = history.length - 1; index >= 0; index -= 1) {
        this.upsertClaimHistory(history[index]);
      }

      this.trimClaimHistory(historyMaxEntries);
    });
  }

  upsertFollowupRuntimeState(input: { version: number }): void {
    const db = this.getDb();
    const nowIso = new Date().toISOString();
    db.prepare(
      `
        INSERT INTO followup_runtime_state (
          id,
          version,
          updated_at
        )
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          version = excluded.version,
          updated_at = excluded.updated_at
      `,
    ).run(FOLLOWUP_STATE_ROW_ID, input.version, nowIso);
  }

  upsertFollowupActive(record: PrFollowupRecord): void {
    const db = this.getDb();
    db.prepare(
      `
        INSERT INTO followup_active (
          work_item_id,
          repo,
          pr_number,
          source_event_id,
          status,
          last_updated,
          payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(work_item_id) DO UPDATE SET
          repo = excluded.repo,
          pr_number = excluded.pr_number,
          source_event_id = excluded.source_event_id,
          status = excluded.status,
          last_updated = excluded.last_updated,
          payload_json = excluded.payload_json
      `,
    ).run(
      record.work_item_id,
      record.repo,
      record.pr_number,
      record.source_event_id,
      record.status,
      record.last_updated,
      JSON.stringify(record),
    );
  }

  deleteFollowupActive(workItemId: string): void {
    const db = this.getDb();
    db.prepare(
      `
        DELETE FROM followup_active
        WHERE work_item_id = ?
      `,
    ).run(workItemId);
  }

  upsertFollowupHistory(record: PrFollowupRecord): void {
    const db = this.getDb();
    db.prepare(
      `
        INSERT INTO followup_history (
          work_item_id,
          repo,
          pr_number,
          source_event_id,
          status,
          last_updated,
          payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(work_item_id) DO UPDATE SET
          repo = excluded.repo,
          pr_number = excluded.pr_number,
          source_event_id = excluded.source_event_id,
          status = excluded.status,
          last_updated = excluded.last_updated,
          payload_json = excluded.payload_json
      `,
    ).run(
      record.work_item_id,
      record.repo,
      record.pr_number,
      record.source_event_id,
      record.status,
      record.last_updated,
      JSON.stringify(record),
    );
  }

  deleteFollowupHistory(workItemId: string): void {
    const db = this.getDb();
    db.prepare(
      `
        DELETE FROM followup_history
        WHERE work_item_id = ?
      `,
    ).run(workItemId);
  }

  trimFollowupHistory(maxEntries: number): void {
    const normalizedMax = Math.max(0, maxEntries);
    const db = this.getDb();
    db.prepare(
      `
        DELETE FROM followup_history
        WHERE history_index IN (
          SELECT history_index
          FROM followup_history
          ORDER BY history_index DESC
          LIMIT -1 OFFSET ?
        )
      `,
    ).run(normalizedMax);
  }

  upsertSeenSourceEvent(sourceEventId: string, seenAtIso: string): void {
    const normalized = sourceEventId.trim();
    if (!normalized) {
      return;
    }

    const db = this.getDb();
    db.prepare(
      `
        INSERT INTO followup_seen_source_events (
          source_event_id,
          seen_at
        )
        VALUES (?, ?)
        ON CONFLICT(source_event_id) DO UPDATE SET
          seen_at = excluded.seen_at
      `,
    ).run(normalized, seenAtIso);
  }

  deleteSeenSourceEvent(sourceEventId: string): void {
    const normalized = sourceEventId.trim();
    if (!normalized) {
      return;
    }

    const db = this.getDb();
    db.prepare(
      `
        DELETE FROM followup_seen_source_events
        WHERE source_event_id = ?
      `,
    ).run(normalized);
  }

  trimSeenSourceEvents(maxEntries: number): void {
    const normalizedMax = Math.max(0, maxEntries);
    const db = this.getDb();
    db.prepare(
      `
        DELETE FROM followup_seen_source_events
        WHERE source_event_id IN (
          SELECT source_event_id
          FROM followup_seen_source_events
          ORDER BY seen_at DESC
          LIMIT -1 OFFSET ?
        )
      `,
    ).run(normalizedMax);
  }

  clearFollowupState(): void {
    const db = this.getDb();
    db.exec(`
      DELETE FROM followup_active;
      DELETE FROM followup_history;
      DELETE FROM followup_seen_source_events;
      DELETE FROM followup_runtime_state WHERE id = ${FOLLOWUP_STATE_ROW_ID};
    `);
  }

  replaceFollowupState(
    state: FollowupPersistedState,
    maxEntries: number,
    seenSourceIdMaxEntries: number,
  ): void {
    this.runInTransaction(() => {
      this.clearFollowupState();
      this.upsertFollowupRuntimeState({
        version: state.version,
      });

      for (const record of state.active_followups ?? []) {
        this.upsertFollowupActive(record);
      }

      const history = (state.history ?? []).slice(0, Math.max(0, maxEntries));
      for (let index = history.length - 1; index >= 0; index -= 1) {
        this.upsertFollowupHistory(history[index]);
      }

      const nowMs = Date.now();
      const seenSourceIds = (state.seen_source_event_ids ?? []).slice(0, Math.max(0, seenSourceIdMaxEntries));
      for (const [index, sourceEventId] of seenSourceIds.entries()) {
        this.upsertSeenSourceEvent(sourceEventId, new Date(nowMs - index).toISOString());
      }

      this.trimFollowupHistory(maxEntries);
      this.trimSeenSourceEvents(seenSourceIdMaxEntries);
    });
  }

  async markWebhookDeliveryIfNew(deliveryId: string): Promise<boolean> {
    const normalized = deliveryId.trim();
    if (!normalized) {
      return false;
    }

    const db = this.getDb();
    const nowIso = new Date().toISOString();
    const result = db
      .prepare(
        `
          INSERT OR IGNORE INTO webhook_deliveries (delivery_id, seen_at)
          VALUES (?, ?)
        `,
      )
      .run(normalized, nowIso) as { changes?: number };

    if ((result.changes ?? 0) > 0) {
      this.trimWebhookDedupeIfNeeded(db);
      return true;
    }

    return false;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private trimWebhookDedupeIfNeeded(db: Database): void {
    const row = db
      .query(
        `
          SELECT COUNT(*) as count
          FROM webhook_deliveries
        `,
      )
      .get() as { count: number } | null;
    const count = Number(row?.count ?? 0);

    if (count <= this.webhookDedupeMaxEntries) {
      return;
    }

    const toDelete = count - this.webhookDedupeMaxEntries;
    db.prepare(
      `
        DELETE FROM webhook_deliveries
        WHERE delivery_id IN (
          SELECT delivery_id
          FROM webhook_deliveries
          ORDER BY seen_at ASC
          LIMIT ?
        )
      `,
    ).run(toDelete);
  }

  private getDb(): Database {
    if (!this.db) {
      throw new Error('SQLite store is not initialized');
    }
    return this.db;
  }
}

export function claimSnapshotNamespace(): string {
  return CLAIMS_NAMESPACE;
}

export function followupSnapshotNamespace(): string {
  return FOLLOWUPS_NAMESPACE;
}

function normalizeJournalMode(value: string): string {
  const normalized = value.trim().toUpperCase() || 'WAL';
  if (!ALLOWED_JOURNAL_MODES.has(normalized)) {
    throw new Error(`Invalid SQLITE_JOURNAL_MODE: ${value}`);
  }

  return normalized;
}

function parsePayload<T>(payloadJson: string, table: string): T {
  const parsed = JSON.parse(payloadJson) as T;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Table ${table} has invalid payload`);
  }

  return parsed;
}
