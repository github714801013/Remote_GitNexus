import path from 'node:path';

/** 单轮巡检最多调度的仓库数。 */
export const STALE_ANALYZE_MAX_PER_ROUND = 10;

/** 参与索引分支映射的 webhook 目标；带 env 表示由 repos.<env>.json 登记的 worktree。 */
export interface WebhookBranchSource {
  repoPath: string;
  branch: string;
  env?: string;
}

export interface StaleAnalyzeCandidate {
  repoPath: string;
  commitsBehind: number;
}

/**
 * 只有主仓的索引分支跟随 webhook 源分支。
 * env worktree 的索引分支是它自己的分支，用源分支覆盖会让巡检恒判分支不匹配。
 */
export const buildWebhookBranchByPath = (
  targets: readonly WebhookBranchSource[],
): Map<string, string> => {
  const byPath = new Map<string, string>();
  for (const target of targets) {
    if (target.env) continue;
    byPath.set(path.resolve(target.repoPath), target.branch);
  }
  return byPath;
};

/** 仅当索引分支已知且与 checkout 分支不一致时返回真；索引分支缺失时保持原有调度行为。 */
export const isKnownBranchMismatch = (
  currentBranch: string | null,
  indexBranch: string | null | undefined,
): boolean => Boolean(indexBranch) && currentBranch !== indexBranch;

/** 过滤失败隔离与无差异候选，按落后数降序稳定排序后截取前 limit 个。 */
export const selectStaleAnalyzeCandidates = <T extends StaleAnalyzeCandidate>(
  candidates: readonly T[],
  failedRepoPaths: ReadonlySet<string>,
  limit: number = STALE_ANALYZE_MAX_PER_ROUND,
): T[] =>
  candidates
    .filter((candidate) => candidate.commitsBehind > 0 && !failedRepoPaths.has(candidate.repoPath))
    .sort((a, b) => b.commitsBehind - a.commitsBehind)
    .slice(0, limit);
