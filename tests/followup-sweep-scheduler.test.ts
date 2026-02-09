import { describe, expect, test } from 'bun:test';
import { FollowupManager } from '../src/followup-manager';
import { Logger } from '../src/logger';
import { startFollowupSweepScheduler } from '../src/followup-sweep-scheduler';

describe('followup sweep scheduler', () => {
  test('stop waits for in-flight sweep completion', async () => {
    let releaseSweep: (() => void) | undefined;
    let runs = 0;

    const followups = {
      async runStaleSweep() {
        runs += 1;
        await new Promise<void>((resolve) => {
          releaseSweep = resolve;
        });
        return { markedStale: 0 };
      },
    } as unknown as FollowupManager;

    const scheduler = startFollowupSweepScheduler({
      followups,
      logger: new Logger({ silent: true }),
      intervalMs: 1,
    });

    await Bun.sleep(10);
    expect(runs).toBe(1);

    let stopped = false;
    const stopPromise = scheduler.stop().then(() => {
      stopped = true;
    });

    await Bun.sleep(10);
    expect(stopped).toBeFalse();

    releaseSweep?.();
    await stopPromise;
    expect(stopped).toBeTrue();
  });
});
