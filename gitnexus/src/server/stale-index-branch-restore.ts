import type { StalenessInfo } from '../core/git-staleness.js';

export interface RestoreIndexBranchParams {
  repo: string;
  repoPath: string;
  lastCommit: string;
  indexBranch: string;
  cloneUrl: string;
  checkoutBranch: string;
}

export interface RestoreIndexBranchDeps {
  cloneOrReset: (url: string, targetDir: string, branch: string) => Promise<unknown>;
  checkStaleness: (repoPath: string, lastCommit: string) => Promise<StalenessInfo>;
  logger: {
    info: (context: Record<string, unknown>, message: string) => void;
    error: (context: Record<string, unknown>, message: string) => void;
  };
}

/** env 预处理曾把主仓检出切到 env 分支；恢复到索引分支后返回真实落后状态，失败时返回 null。 */
export const restoreIndexBranch = async (
  params: RestoreIndexBranchParams,
  deps: RestoreIndexBranchDeps,
): Promise<StalenessInfo | null> => {
  try {
    await deps.cloneOrReset(params.cloneUrl, params.repoPath, params.indexBranch);
    const staleness = await deps.checkStaleness(params.repoPath, params.lastCommit);
    deps.logger.info(
      {
        repo: params.repo,
        indexBranch: params.indexBranch,
        checkoutBranch: params.checkoutBranch,
        commitsBehind: staleness.commitsBehind,
      },
      'Stale index branch restored to index branch',
    );
    return staleness;
  } catch (err) {
    deps.logger.error(
      { err, repo: params.repo, indexBranch: params.indexBranch },
      'stale index branch restore failed',
    );
    return null;
  }
};
