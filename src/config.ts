import { resolve } from 'node:path';
import type { AppConfig } from './types';

function parseNumber(name: string, value: string | undefined, fallback: number): number {
  if (!value || !value.trim()) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric value for ${name}: ${value}`);
  }

  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value || !value.trim()) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean value: ${value}`);
}

function parseAllowedRepos(value: string | undefined): Set<string> {
  if (!value || !value.trim()) {
    return new Set<string>();
  }

  return new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const githubToken = env.GITHUB_TOKEN?.trim();
  if (!githubToken) {
    throw new Error('Missing required env var: GITHUB_TOKEN');
  }

  const apiKey = env.API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Missing required env var: API_KEY');
  }

  return {
    githubToken,
    httpPort: parseNumber('HTTP_PORT', env.HTTP_PORT, 3100),
    sqlitePath: resolve(env.SQLITE_PATH?.trim() || './issuecommand.db'),
    sqliteBusyTimeoutMs: parseNumber('SQLITE_BUSY_TIMEOUT_MS', env.SQLITE_BUSY_TIMEOUT_MS, 5000),
    sqliteJournalMode: env.SQLITE_JOURNAL_MODE?.trim() || 'WAL',
    webhookDedupeMaxEntries: parseNumber('WEBHOOK_DEDUPE_MAX_ENTRIES', env.WEBHOOK_DEDUPE_MAX_ENTRIES, 20000),
    webhookEnabled: parseBoolean(env.WEBHOOK_ENABLED, true),
    webhookPath: env.WEBHOOK_PATH?.trim() || '/api/webhooks/github',
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET?.trim() || undefined,
    claimTimeoutMinutes: parseNumber('CLAIM_TIMEOUT_MINUTES', env.CLAIM_TIMEOUT_MINUTES, 120),
    staleAutoReleaseMinutes: parseNumber(
      'STALE_AUTO_RELEASE_MINUTES',
      env.STALE_AUTO_RELEASE_MINUTES,
      0,
    ),
    followupStaleMinutes: parseNumber('FOLLOWUP_STALE_MINUTES', env.FOLLOWUP_STALE_MINUTES, 1440),
    followupMaxEntries: parseNumber('FOLLOWUP_MAX_ENTRIES', env.FOLLOWUP_MAX_ENTRIES, 2000),
    historyMaxEntries: parseNumber('HISTORY_MAX_ENTRIES', env.HISTORY_MAX_ENTRIES, 1000),
    trustProxy: parseBoolean(env.TRUST_PROXY, false),
    syncIntervalMinutes: parseNumber('SYNC_INTERVAL_MINUTES', env.SYNC_INTERVAL_MINUTES, 15),
    allowedRepos: parseAllowedRepos(env.ALLOWED_REPOS),
    logFile: env.LOG_FILE?.trim() || undefined,
    apiKey,
    autoCloseGithubIssue: parseBoolean(env.AUTO_CLOSE_GITHUB_ISSUE, false),
    rateLimit: {
      enabled: parseBoolean(env.RATE_LIMIT_ENABLED, true),
      ipPerMinute: parseNumber('RATE_LIMIT_IP_PER_MINUTE', env.RATE_LIMIT_IP_PER_MINUTE, 120),
      ipBurst: parseNumber('RATE_LIMIT_IP_BURST', env.RATE_LIMIT_IP_BURST, 40),
      agentMutationsPerMinute: parseNumber(
        'RATE_LIMIT_AGENT_MUTATIONS_PER_MINUTE',
        env.RATE_LIMIT_AGENT_MUTATIONS_PER_MINUTE,
        40,
      ),
      agentMutationsBurst: parseNumber(
        'RATE_LIMIT_AGENT_MUTATIONS_BURST',
        env.RATE_LIMIT_AGENT_MUTATIONS_BURST,
        20,
      ),
      sseConnectPerMinute: parseNumber(
        'RATE_LIMIT_SSE_CONNECT_PER_MINUTE',
        env.RATE_LIMIT_SSE_CONNECT_PER_MINUTE,
        10,
      ),
      sseConnectBurst: parseNumber(
        'RATE_LIMIT_SSE_CONNECT_BURST',
        env.RATE_LIMIT_SSE_CONNECT_BURST,
        10,
      ),
    },
  };
}
