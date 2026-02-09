import { FollowupManager } from './followup-manager';
import { Logger } from './logger';

interface FollowupSweepSchedulerOptions {
  followups: FollowupManager;
  logger: Logger;
  intervalMs: number;
}

interface FollowupSweepScheduler {
  stop: () => Promise<void>;
}

export function startFollowupSweepScheduler(
  options: FollowupSweepSchedulerOptions,
): FollowupSweepScheduler {
  const intervalMs = Math.max(1, options.intervalMs);
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const runSweep = (): void => {
    if (stopped || inFlight) {
      return;
    }

    inFlight = options.followups
      .runStaleSweep()
      .catch((error) => {
        options.logger.warn('followup.stale_sweep_failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .then(() => undefined)
      .finally(() => {
        inFlight = null;
      });
  };

  const timer = setInterval(runSweep, intervalMs);

  return {
    stop: async () => {
      if (stopped) {
        return;
      }

      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
