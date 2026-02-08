import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ClaimManager } from './claim-manager';
import { GitHubClient } from './github';
import { Logger } from './logger';
import { ClaimEvent, SyncReport } from './types';

interface SyncServiceOptions {
  claims: ClaimManager;
  github: GitHubClient;
  logger: Logger;
  intervalMinutes: number;
  allowedRepos: Set<string>;
}

export class SyncService {
  private readonly claims: ClaimManager;
  private readonly github: GitHubClient;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly allowedRepos: Set<string>;
  private readonly events = new EventEmitter();
  private readonly knownOpenIssues = new Map<string, Set<number>>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(options: SyncServiceOptions) {
    this.claims = options.claims;
    this.github = options.github;
    this.logger = options.logger;
    this.intervalMs = Math.max(1, options.intervalMinutes) * 60_000;
    this.allowedRepos = options.allowedRepos;
  }

  onEvent(listener: (event: ClaimEvent) => void): () => void {
    this.events.on('sync_event', listener);
    return () => {
      this.events.off('sync_event', listener);
    };
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);

    void this.runOnce();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<SyncReport> {
    const stale = await this.claims.runStaleSweep();
    const report: SyncReport = {
      repos_scanned: 0,
      open_issues_seen: 0,
      newly_opened_issues: 0,
      externally_closed_claims: 0,
      metadata_updates: 0,
    };

    const repos = await this.resolveRepoList();

    for (const repo of repos) {
      let openIssues;
      try {
        openIssues = await this.github.listOpenIssues(repo);
      } catch (error) {
        this.logger.warn('sync.repo_scan_failed', {
          repo,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      report.repos_scanned += 1;
      report.open_issues_seen += openIssues.length;

      const openSet = new Set<number>(openIssues.map((issue) => issue.number));
      const previousSet = this.knownOpenIssues.get(repo);
      if (!previousSet) {
        this.knownOpenIssues.set(repo, openSet);
      } else {
        for (const issueNumber of openSet) {
          if (!previousSet.has(issueNumber)) {
            report.newly_opened_issues += 1;
          }
        }
        this.knownOpenIssues.set(repo, openSet);
      }

      const claimsForRepo = this.claims.getActiveClaims({ repo });
      const openByNumber = new Map(openIssues.map((issue) => [issue.number, issue]));

      for (const claim of claimsForRepo) {
        const issue = openByNumber.get(claim.issue_number);
        if (!issue) {
          const result = await this.claims.reconcileIssueSnapshot({
            repo,
            issue_number: claim.issue_number,
            title: claim.issue_title,
            labels: claim.issue_labels,
            assignees: claim.issue_assignees,
            state: 'closed',
          });

          if (result.externallyClosed) {
            report.externally_closed_claims += 1;
          }
          continue;
        }

        const metadataResult = await this.claims.reconcileIssueSnapshot({
          repo,
          issue_number: claim.issue_number,
          title: issue.title,
          labels: issue.labels,
          assignees: issue.assignees,
          state: issue.state,
        });

        if (metadataResult.metadataUpdated) {
          report.metadata_updates += 1;
        }
      }
    }

    const timestamp = new Date().toISOString();
    this.claims.setLastGithubSyncAt(timestamp);

    const event: ClaimEvent = {
      event_id: randomUUID(),
      type: 'sync.reconciled',
      timestamp,
      details: {
        ...report,
        stale_marked: stale.markedStale,
        stale_auto_released: stale.autoReleased,
      },
    };

    this.events.emit('sync_event', event);

    this.logger.info('sync.reconciled', {
      ...report,
      stale_marked: stale.markedStale,
      stale_auto_released: stale.autoReleased,
    });

    return report;
  }

  private async resolveRepoList(): Promise<string[]> {
    if (this.allowedRepos.size > 0) {
      return [...this.allowedRepos.values()].sort();
    }

    const repos = await this.github.listRepos({ includeCounts: false });
    return repos.map((repo) => repo.full_name).sort();
  }
}
