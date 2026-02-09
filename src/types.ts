export type ClaimStatus =
  | 'claimed'
  | 'in_progress'
  | 'pr_submitted'
  | 'pr_merged'
  | 'closed'
  | 'released'
  | 'stale';

export type WorkItemType = 'issue' | 'pr_followup';

export type FollowupStatus = 'queued' | 'claimed' | 'in_progress' | 'done' | 'dismissed' | 'stale';

export type FollowupSourceEventType =
  | 'review_changes_requested'
  | 'review_comment'
  | 'pr_comment'
  | 'pr_synchronize';

export interface StatusEntry {
  status: ClaimStatus;
  timestamp: string;
  note?: string;
}

export interface ClaimRecord {
  claim_id: string;
  agent_id: string;
  repo: string;
  issue_number: number;
  issue_title: string;
  issue_labels: string[];
  issue_assignees: string[];
  status: ClaimStatus;
  claimed_at: string;
  last_updated: string;
  status_history: StatusEntry[];
  pr_url?: string;
}

export interface RepoSummary {
  full_name: string;
  owner: string;
  name: string;
  url: string;
  description?: string;
  private: boolean;
  open_issue_count: number;
}

export interface IssueComment {
  author: string;
  body: string;
  created_at: string;
  url?: string;
}

export interface GitHubIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
  milestone?: string;
  comments: IssueComment[];
  created_at: string;
  updated_at: string;
  url: string;
}

export interface ListIssueOptions {
  label?: string;
  milestone?: string;
}

export interface ClaimRequest {
  agent_id: string;
  repo: string;
  issue_number: number;
  issue_title: string;
  issue_labels?: string[];
  issue_assignees?: string[];
}

export interface ReleaseRequest {
  claim_id: string;
  agent_id?: string;
  reason?: string;
}

export interface UpdateClaimStatusRequest {
  claim_id: string;
  agent_id?: string;
  status: ClaimStatus;
  note?: string;
  pr_url?: string;
  source?: 'agent' | 'sync';
}

export interface FollowupStatusEntry {
  status: FollowupStatus;
  timestamp: string;
  note?: string;
}

export interface PrFollowupRecord {
  work_item_id: string;
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
  status: FollowupStatus;
  created_at: string;
  last_updated: string;
  claimed_by_agent_id?: string;
  claimed_at?: string;
  done_at?: string;
  dismiss_reason?: string;
  status_history: FollowupStatusEntry[];
}

export interface FollowupFilters {
  repo?: string;
  status?: FollowupStatus;
  claimed_by_agent_id?: string;
  pr_number?: number;
}

export interface FollowupOperationResult {
  ok: boolean;
  work_item?: PrFollowupRecord;
  idempotent?: boolean;
  reason?:
    | 'not_found'
    | 'already_claimed'
    | 'invalid_transition'
    | 'agent_mismatch'
    | 'no_followup_available'
    | 'unknown';
  message?: string;
  owner_agent_id?: string;
}

export interface ClaimOperationResult {
  ok: boolean;
  claim?: ClaimRecord;
  idempotent?: boolean;
  reason?:
    | 'already_claimed'
    | 'claim_not_found'
    | 'invalid_transition'
    | 'agent_mismatch'
    | 'invalid_repo'
    | 'invalid_issue'
    | 'unknown';
  message?: string;
  owner_agent_id?: string;
}

export interface ClaimFilters {
  agent_id?: string;
  repo?: string;
  status?: ClaimStatus;
}

export interface FollowupHistoryPage {
  items: PrFollowupRecord[];
  next_cursor?: string;
}

export interface MyWorkResponse {
  claims: ClaimRecord[];
  followups: PrFollowupRecord[];
}

export type NextWorkResult =
  | {
      ok: true;
      kind: 'pr_followup';
      work_item: PrFollowupRecord;
    }
  | {
      ok: true;
      kind: 'issue';
      claim: ClaimRecord;
      issue: GitHubIssue;
    }
  | {
      ok: false;
      reason?: string;
      message?: string;
    };

export type ClaimEventType =
  | 'claim.created'
  | 'claim.released'
  | 'claim.updated'
  | 'claim.stale'
  | 'claim.auto_released'
  | 'followup.created'
  | 'followup.claimed'
  | 'followup.updated'
  | 'followup.done'
  | 'followup.dismissed'
  | 'followup.stale'
  | 'webhook.received'
  | 'webhook.rejected'
  | 'sync.reconciled';

export interface ClaimEvent {
  event_id: string;
  type: ClaimEventType;
  timestamp: string;
  claim_id?: string;
  work_item_id?: string;
  repo?: string;
  issue_number?: number;
  pr_number?: number;
  agent_id?: string;
  details?: Record<string, unknown>;
}

export interface PersistedState {
  version: number;
  started_at: string;
  total_claims: number;
  last_github_sync_at?: string;
  active_claims: ClaimRecord[];
  history: ClaimRecord[];
}

export interface FollowupPersistedState {
  version: number;
  active_followups: PrFollowupRecord[];
  history: PrFollowupRecord[];
  seen_source_event_ids: string[];
}

export interface HistoryPage {
  items: ClaimRecord[];
  next_cursor?: string;
}

export interface SystemHealth {
  uptime_seconds: number;
  total_claims: number;
  active_claims: number;
  active_agents: number;
  stale_claims: number;
  last_github_sync_at?: string;
}

export interface AppConfig {
  githubToken: string;
  httpPort: number;
  sqlitePath: string;
  sqliteBusyTimeoutMs: number;
  sqliteJournalMode: string;
  webhookDedupeMaxEntries: number;
  webhookEnabled: boolean;
  webhookPath: string;
  githubWebhookSecret?: string;
  claimTimeoutMinutes: number;
  staleAutoReleaseMinutes: number;
  followupStaleMinutes: number;
  followupMaxEntries: number;
  historyMaxEntries: number;
  trustProxy: boolean;
  syncIntervalMinutes: number;
  allowedRepos: Set<string>;
  logFile?: string;
  apiKey: string;
  autoCloseGithubIssue: boolean;
  rateLimit: RateLimitConfig;
}

export interface RateLimitConfig {
  enabled: boolean;
  ipPerMinute: number;
  ipBurst: number;
  agentMutationsPerMinute: number;
  agentMutationsBurst: number;
  sseConnectPerMinute: number;
  sseConnectBurst: number;
}

export interface SyncReport {
  repos_scanned: number;
  open_issues_seen: number;
  newly_opened_issues: number;
  externally_closed_claims: number;
  metadata_updates: number;
}

export function parseRepo(repo: string): { owner: string; name: string } {
  const parts = repo.split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(`Invalid repo format: ${repo}. Expected owner/repo.`);
  }

  return {
    owner: parts[0],
    name: parts[1],
  };
}

export function issueKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

export function isTerminalStatus(status: ClaimStatus): boolean {
  return status === 'closed' || status === 'released';
}
