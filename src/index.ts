import { loadConfig } from './config';
import { ClaimManager } from './claim-manager';
import { GitHubService } from './github';
import { startHttpServer } from './http-server';
import { Logger } from './logger';
import { startMcpServer } from './mcp-server';
import { StatePersistence } from './state-persistence';
import { SyncService } from './sync';
import { IssueCommandService } from './issuecommand-service';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger({
    logFile: config.logFile,
  });

  logger.info('issuecommand.starting', {
    port: config.httpPort,
    state_file_path: config.stateFilePath,
    sync_interval_minutes: config.syncIntervalMinutes,
    allowed_repos_count: config.allowedRepos.size,
  });

  const persistence = new StatePersistence({
    filePath: config.stateFilePath,
    logger,
  });

  const claimManager = new ClaimManager({
    claimTimeoutMinutes: config.claimTimeoutMinutes,
    staleAutoReleaseMinutes: config.staleAutoReleaseMinutes,
    persistence,
    logger,
  });

  await claimManager.initialize();

  const github = new GitHubService({
    token: config.githubToken,
    logger,
    allowedRepos: config.allowedRepos,
  });

  const service = new IssueCommandService({
    claims: claimManager,
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
    sync,
    config,
    logger,
  });

  sync.start();

  const mcp = await startMcpServer({
    service,
    logger,
  });

  logger.info('issuecommand.started', {
    http_port: http.port,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('issuecommand.shutting_down', { signal });

    sync.stop();
    http.stop();
    await mcp.close();
    await persistence.flush();

    process.exit(0);
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
