import { loadConfig } from './config';
import { ClaimManager } from './claim-manager';
import { FollowupManager } from './followup-manager';
import { GitHubService } from './github';
import { GitHubWebhookConnector } from './github-webhook';
import { startHttpServer } from './http-server';
import { Logger } from './logger';
import { startMcpServer } from './mcp-server';
import { SyncService } from './sync';
import { IssueCommandService } from './issuecommand-service';
import { initializePersistence } from './persistence/create-persistence';
import { startFollowupSweepScheduler } from './followup-sweep-scheduler';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger({
    logFile: config.logFile,
  });

  logger.info('issuecommand.starting', {
    port: config.httpPort,
    sqlite_path: config.sqlitePath,
    sync_interval_minutes: config.syncIntervalMinutes,
    allowed_repos_count: config.allowedRepos.size,
  });

  const {
    claimPersistence: persistence,
    followupPersistence,
    sqliteStore,
  } = await initializePersistence(config, logger);

  const claimManager = new ClaimManager({
    claimTimeoutMinutes: config.claimTimeoutMinutes,
    staleAutoReleaseMinutes: config.staleAutoReleaseMinutes,
    historyMaxEntries: config.historyMaxEntries,
    persistence,
    logger,
  });

  await claimManager.initialize();

  const followupManager = new FollowupManager({
    persistence: followupPersistence,
    logger,
    maxEntries: config.followupMaxEntries,
    staleMinutes: config.followupStaleMinutes,
  });
  await followupManager.initialize();

  const github = new GitHubService({
    token: config.githubToken,
    logger,
    allowedRepos: config.allowedRepos,
  });

  const ghAvailability = await github.checkGhAvailability();
  if (ghAvailability.available) {
    logger.info('github.gh.available', {
      version: ghAvailability.version,
    });
  } else {
    logger.warn('github.gh.unavailable', {
      reason: ghAvailability.reason,
      fallback_mode: 'rest_api',
    });
  }

  const webhookConnector = config.webhookEnabled
    ? new GitHubWebhookConnector({
        apiKey: config.apiKey,
        webhookSecret: config.githubWebhookSecret,
        followups: followupManager,
        logger,
        webhookDedupe: sqliteStore
          ? {
              markDeliveryIfNew: (deliveryId: string) => sqliteStore!.markWebhookDeliveryIfNew(deliveryId),
            }
          : undefined,
      })
    : undefined;

  if (webhookConnector) {
    logger.info('webhook.github.enabled', {
      path: config.webhookPath,
      auth_modes: config.githubWebhookSecret ? ['signature', 'api_key'] : ['api_key'],
    });
  } else {
    logger.info('webhook.github.disabled');
  }

  const service = new IssueCommandService({
    claims: claimManager,
    followups: followupManager,
    github,
    logger,
    autoCloseGithubIssue: config.autoCloseGithubIssue,
  });

  const sync = new SyncService({
    claims: claimManager,
    github,
    logger,
    intervalMinutes: config.syncIntervalMinutes,
    allowedRepos: config.allowedRepos,
  });

  const http = startHttpServer({
    service,
    claims: claimManager,
    followups: followupManager,
    sync,
    webhooks: webhookConnector,
    config,
    logger,
  });

  sync.start();

  const followupSweep = startFollowupSweepScheduler({
    followups: followupManager,
    logger,
    intervalMs: Math.max(1, config.syncIntervalMinutes) * 60_000,
  });

  const mcp = await startMcpServer({
    service,
    logger,
  });

  logger.info('issuecommand.started', {
    http_port: http.port,
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      logger.info('issuecommand.shutting_down', { signal });

      http.stop();
      await sync.stop();
      await followupSweep.stop();
      await mcp.close();
      await persistence.flush();
      await followupPersistence.flush();
      sqliteStore?.close();

      process.exit(0);
    })();

    return shutdownPromise;
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'issuecommand.fatal',
      details: {
        message,
      },
    }),
  );
  process.exit(1);
});
