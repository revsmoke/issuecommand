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
    claimTimeoutMinutes: parseNumber('CLAIM_TIMEOUT_MINUTES', env.CLAIM_TIMEOUT_MINUTES, 120),
    staleAutoReleaseMinutes: parseNumber(
      'STALE_AUTO_RELEASE_MINUTES',
      env.STALE_AUTO_RELEASE_MINUTES,
      0,
    ),
    stateFilePath: resolve(env.STATE_FILE_PATH?.trim() || './issuecommand-state.json'),
    syncIntervalMinutes: parseNumber('SYNC_INTERVAL_MINUTES', env.SYNC_INTERVAL_MINUTES, 15),
    allowedRepos: parseAllowedRepos(env.ALLOWED_REPOS),
    logFile: env.LOG_FILE?.trim() || undefined,
    apiKey,
    autoCloseGithubIssue: parseBoolean(env.AUTO_CLOSE_GITHUB_ISSUE, false),
  };
}
