import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '../src/logger';
import { StatePersistence } from '../src/state-persistence';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }

    await rm(dir, { recursive: true, force: true });
  }
});

describe('StatePersistence', () => {
  test('returns null when state file does not exist', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-state-persistence-missing-'));
    tempDirs.push(tempDir);
    const logger = new Logger({ silent: true });
    const persistence = new StatePersistence({
      filePath: join(tempDir, 'missing.json'),
      logger,
    });

    const loaded = await persistence.load();
    expect(loaded).toBeNull();
  });

  test('throws on malformed JSON state to fail fast', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'issuecommand-state-persistence-corrupt-'));
    tempDirs.push(tempDir);
    const filePath = join(tempDir, 'corrupt.json');
    await writeFile(filePath, '{ not valid json', 'utf8');

    const logger = new Logger({ silent: true });
    const persistence = new StatePersistence({
      filePath,
      logger,
    });

    await expect(persistence.load()).rejects.toThrow();
  });
});
