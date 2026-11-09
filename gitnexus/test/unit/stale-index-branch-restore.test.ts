import { describe, expect, it, vi } from 'vitest';
import { restoreIndexBranch } from '../../src/server/stale-index-branch-restore.js';

const params = {
  repo: 'dev-imservice',
  repoPath: 'projects/JiuJi-JAVA/dev-imservice',
  lastCommit: 'abc123',
  indexBranch: 'release_9ji',
  cloneUrl: 'https://gitea.example/JiuJi-JAVA/imservice.git',
  checkoutBranch: 'dev',
};

const createLogger = () => ({
  info: vi.fn(),
  error: vi.fn(),
});

describe('restoreIndexBranch', () => {
  it('restores the index branch and returns the refreshed staleness', async () => {
    const staleness = { isStale: true, commitsBehind: 7, status: 'behind' as const };
    const cloneOrReset = vi.fn(async () => 'ok');
    const checkStaleness = vi.fn(async () => staleness);
    const logger = createLogger();

    const result = await restoreIndexBranch(params, { cloneOrReset, checkStaleness, logger });

    expect(cloneOrReset).toHaveBeenCalledWith(params.cloneUrl, params.repoPath, params.indexBranch);
    expect(checkStaleness).toHaveBeenCalledWith(params.repoPath, params.lastCommit);
    expect(result).toEqual(staleness);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: params.repo,
        indexBranch: params.indexBranch,
        checkoutBranch: params.checkoutBranch,
        commitsBehind: staleness.commitsBehind,
      }),
      'Stale index branch restored to index branch',
    );
  });

  it('returns null and logs when the restore fails', async () => {
    const cloneOrReset = vi.fn(async () => {
      throw new Error('checkout failed');
    });
    const checkStaleness = vi.fn();
    const logger = createLogger();

    const result = await restoreIndexBranch(params, { cloneOrReset, checkStaleness, logger });

    expect(result).toBeNull();
    expect(checkStaleness).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ repo: params.repo, indexBranch: params.indexBranch }),
      'stale index branch restore failed',
    );
    expect(logger.info).not.toHaveBeenCalled();
  });
});
