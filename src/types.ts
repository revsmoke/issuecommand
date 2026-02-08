export type ClaimStatus =
  | 'claimed'
  | 'in_progress'
  | 'pr_submitted'
  | 'pr_merged'
  | 'closed'
  | 'released'
  | 'stale';

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
  status: ClaimStatus;
  note?: string;
  pr_url?: string;
  source?: 'agent' | 'sync';
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

export type ClaimEventType =
  | 'claim.created'
  | 'claim.released'
  | 'claim.updated'
  | 'claim.stale'
  | 'claim.auto_released'
  | 'sync.reconciled';

export interface ClaimEvent {
  event_id: string;
  type: ClaimEventType;
  timestamp: string;
  claim_id?: string;
  repo?: string;
  issue_number?: number;
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
  claimTimeoutMinutes: number;
  staleAutoReleaseMinutes: number;
  stateFilePath: string;
  syncIntervalMinutes: number;
  allowedRepos: Set<string>;
  logFile?: string;
  apiKey: string;
  autoCloseGithubIssue: boolean;
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
