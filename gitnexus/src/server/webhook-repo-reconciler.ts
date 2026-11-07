import path from 'path';
import type { WebhookAnalyzeQueueResult } from './webhook-analyze-queue.js';
import type { EnsureWorktreeParams } from './webhook-worktree.js';

/** 对账所需的 webhook 目标字段，与 WebhookInspectionTarget 结构兼容。 */
export interface WebhookReconcileTarget {
  fullName: string;
  repoPath: string;
  mainRepoPath: string;
  cloneUrl?: string;
  branch: string;
  repoName: string;
  registryName: string;
  allowDuplicateName?: boolean;
  env?: string;
}

export interface WebhookReconcileLogger {
  info: (context: Record<string, unknown>, message: string) => void;
  warn: (context: Record<string, unknown>, message: string) => void;
  error: (context: Record<string, unknown>, message: string) => void;
}

export type WebhookReconcileQueueResult = WebhookAnalyzeQueueResult;

export interface WebhookReconcileDeps {
  pathExists: (targetPath: string) => Promise<boolean>;
  enqueue: (target: WebhookReconcileTarget) => WebhookReconcileQueueResult;
  logger: WebhookReconcileLogger;
}

export interface WebhookReconcileResult {
  missing: number;
  enqueued: number;
  deferred: number;
  skippedNoCloneUrl: number;
}

/** 启动重放开启时已覆盖全部目标，巡检不再对账；其余来源始终对账。 */
export const shouldReconcileMissingWebhookTargets = (
  source: 'startup' | 'manual',
  startupReplayEnabled: boolean,
): boolean => source !== 'startup' || !startupReplayEnabled;

/** 逐个检查 webhook 目标的 repoPath/.git，缺失且可克隆时入队。 */
export const reconcileMissingWebhookTargets = async (
  targets: readonly WebhookReconcileTarget[],
  deps: WebhookReconcileDeps,
): Promise<WebhookReconcileResult> => {
  let missing = 0;
  let enqueued = 0;
  let deferred = 0;
  let skippedNoCloneUrl = 0;

  for (const target of targets) {
    if (await deps.pathExists(path.join(target.repoPath, '.git'))) continue;
    missing += 1;
    if (!target.cloneUrl) {
      skippedNoCloneUrl += 1;
      deps.logger.warn(
        { repo: target.fullName, repoPath: target.repoPath },
        'Skipping webhook target without cloneUrl',
      );
      continue;
    }

    let queued: WebhookReconcileQueueResult;
    try {
      queued = deps.enqueue(target);
    } catch (err) {
      deps.logger.error(
        { err, repo: target.fullName, repoPath: target.repoPath },
        'Failed to enqueue missing webhook repo',
      );
      continue;
    }

    if (queued.status === 'deferred') {
      deferred += 1;
    } else {
      enqueued += 1;
    }
    deps.logger.info(
      { repo: target.fullName, repoPath: target.repoPath, status: queued.status },
      'reconcile missing webhook repo queued',
    );
    queued.done.catch((err) => {
      deps.logger.error(
        { err, repo: target.fullName, repoPath: target.repoPath },
        'Webhook repo reconciliation failed',
      );
    });
  }

  return { missing, enqueued, deferred, skippedNoCloneUrl };
};

export type WebhookWorktreeParams = EnsureWorktreeParams;

export interface WebhookBeforeAnalyzeDeps {
  cloneOrReset: (url: string, targetDir: string, branch: string) => Promise<unknown>;
  ensureWorktree: (params: WebhookWorktreeParams) => Promise<unknown>;
}

/** 构造队列任务的 beforeAnalyze：普通目标补克隆，env 目标补主仓后重建 worktree。 */
export const createWebhookBeforeAnalyze = (
  target: WebhookReconcileTarget,
  deps: WebhookBeforeAnalyzeDeps,
): (() => Promise<void>) => async () => {
  if (!target.cloneUrl) return;
  if (!target.env) {
    await deps.cloneOrReset(target.cloneUrl, target.repoPath, target.branch);
    return;
  }
  await deps.cloneOrReset(target.cloneUrl, target.mainRepoPath, target.branch);
  await deps.ensureWorktree({
    mainRepoPath: target.mainRepoPath,
    worktreePath: target.repoPath,
    branch: target.registryName,
    baseRef: `origin/${target.branch}`,
    resetToRef: `origin/${target.branch}`,
  });
};
