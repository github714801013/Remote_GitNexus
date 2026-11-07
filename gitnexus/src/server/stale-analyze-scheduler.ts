/** 单轮巡检最多调度的仓库数。 */
export const STALE_ANALYZE_MAX_PER_ROUND = 10;

export interface StaleAnalyzeCandidate {
  repoPath: string;
  commitsBehind: number;
}

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
