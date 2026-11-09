import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createWebhookBeforeAnalyze,
  reconcileMissingWebhookTargets,
  shouldReconcileMissingWebhookTargets,
  type WebhookReconcileTarget,
} from '../../src/server/webhook-repo-reconciler.js';

const PROJECTS_ROOT = path.join('projects', 'JiuJi-JAVA');

const target = (overrides: Partial<WebhookReconcileTarget> = {}): WebhookReconcileTarget => ({
  fullName: 'JiuJi-JAVA/imservice',
  repoPath: path.join(PROJECTS_ROOT, 'imservice'),
  mainRepoPath: path.join(PROJECTS_ROOT, 'imservice'),
  cloneUrl: 'https://gitea.example/JiuJi-JAVA/imservice.git',
  branch: 'master',
  repoName: 'imservice',
  registryName: 'imservice',
  ...overrides,
});

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe('reconcileMissingWebhookTargets', () => {
  it('enqueues a target when repoPath/.git is missing', async () => {
    const pathExists = vi.fn(async () => false);
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, done: Promise.resolve() }));
    const logger = createLogger();
    const webhookTarget = target();

    const result = await reconcileMissingWebhookTargets([webhookTarget], {
      pathExists,
      enqueue,
      logger,
    });

    expect(pathExists).toHaveBeenCalledWith(path.join(webhookTarget.repoPath, '.git'));
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(webhookTarget);
    expect(result).toEqual({ missing: 1, enqueued: 1, deferred: 0, skippedNoCloneUrl: 0 });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: webhookTarget.fullName,
        repoPath: webhookTarget.repoPath,
      }),
      expect.any(String),
    );
  });

  it('checks .git rather than only the repository directory', async () => {
    const webhookTarget = target();
    const gitDir = path.join(webhookTarget.repoPath, '.git');
    const pathExists = vi.fn(async (targetPath: string) => targetPath !== gitDir);
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, done: Promise.resolve() }));

    const result = await reconcileMissingWebhookTargets([webhookTarget], {
      pathExists,
      enqueue,
      logger: createLogger(),
    });

    expect(pathExists).toHaveBeenCalledWith(gitDir);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(result.enqueued).toBe(1);
  });

  it('skips a target when repoPath/.git exists', async () => {
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, done: Promise.resolve() }));

    const result = await reconcileMissingWebhookTargets([target()], {
      pathExists: vi.fn(async () => true),
      enqueue,
      logger: createLogger(),
    });

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toEqual({ missing: 0, enqueued: 0, deferred: 0, skippedNoCloneUrl: 0 });
  });

  it('skips a target without cloneUrl and logs a warning', async () => {
    const pathExists = vi.fn(async () => false);
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, done: Promise.resolve() }));
    const logger = createLogger();
    const webhookTarget = target({ cloneUrl: undefined });

    const result = await reconcileMissingWebhookTargets([webhookTarget], {
      pathExists,
      enqueue,
      logger,
    });

    expect(pathExists).toHaveBeenCalledWith(path.join(webhookTarget.repoPath, '.git'));
    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toEqual({ missing: 1, enqueued: 0, deferred: 0, skippedNoCloneUrl: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: webhookTarget.fullName,
        repoPath: webhookTarget.repoPath,
      }),
      expect.any(String),
    );
  });

  it('counts deferred targets without treating them as enqueued', async () => {
    const enqueue = vi.fn(() => ({ status: 'deferred' as const, done: Promise.resolve() }));

    const result = await reconcileMissingWebhookTargets([target()], {
      pathExists: vi.fn(async () => false),
      enqueue,
      logger: createLogger(),
    });

    expect(result).toEqual({ missing: 1, enqueued: 0, deferred: 1, skippedNoCloneUrl: 0 });
  });

  it('logs an asynchronous enqueue failure and continues with the next target', async () => {
    let rejectDone!: (err: Error) => void;
    const failedDone = new Promise<void>((_, reject) => {
      rejectDone = reject;
    });
    const enqueue = vi
      .fn()
      .mockReturnValueOnce({ status: 'accepted' as const, done: failedDone })
      .mockReturnValueOnce({ status: 'accepted' as const, done: Promise.resolve() });
    const logger = createLogger();
    const targets = [
      target({ fullName: 'JiuJi-JAVA/first', repoPath: path.join(PROJECTS_ROOT, 'first') }),
      target({ fullName: 'JiuJi-JAVA/second', repoPath: path.join(PROJECTS_ROOT, 'second') }),
    ];

    const reconcile = reconcileMissingWebhookTargets(targets, {
      pathExists: vi.fn(async () => false),
      enqueue,
      logger,
    });
    rejectDone(new Error('clone failed'));
    const result = await reconcile;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.missing).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'JiuJi-JAVA/first' }),
      expect.any(String),
    );
  });

  it('logs a synchronous enqueue error and continues with the next target', async () => {
    const enqueue = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('queue unavailable');
      })
      .mockReturnValueOnce({ status: 'accepted' as const, done: Promise.resolve() });
    const logger = createLogger();
    const targets = [
      target({ fullName: 'JiuJi-JAVA/first', repoPath: path.join(PROJECTS_ROOT, 'first') }),
      target({ fullName: 'JiuJi-JAVA/second', repoPath: path.join(PROJECTS_ROOT, 'second') }),
    ];

    const result = await reconcileMissingWebhookTargets(targets, {
      pathExists: vi.fn(async () => false),
      enqueue,
      logger,
    });

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ missing: 2, enqueued: 1, deferred: 0, skippedNoCloneUrl: 0 });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'JiuJi-JAVA/first' }),
      expect.any(String),
    );
  });
});

describe('createWebhookBeforeAnalyze', () => {
  it('clones a normal repository into repoPath', async () => {
    const cloneOrReset = vi.fn(async () => 'ok');
    const ensureWorktree = vi.fn(async () => ({}));
    const webhookTarget = target();

    const beforeAnalyze = createWebhookBeforeAnalyze(webhookTarget, {
      cloneOrReset,
      ensureWorktree,
      pathExists: vi.fn(async () => false),
    });
    await beforeAnalyze();

    expect(cloneOrReset).toHaveBeenCalledWith(
      webhookTarget.cloneUrl,
      webhookTarget.repoPath,
      webhookTarget.branch,
    );
    expect(ensureWorktree).not.toHaveBeenCalled();
  });

  it('clones a missing main repository and creates the env worktree', async () => {
    const cloneOrReset = vi.fn(async () => 'ok');
    const ensureWorktree = vi.fn(async () => ({}));
    const webhookTarget = target({
      env: 'dev',
      repoPath: path.join(PROJECTS_ROOT, 'dev-imservice'),
      registryName: 'dev-imservice',
    });

    const beforeAnalyze = createWebhookBeforeAnalyze(webhookTarget, {
      cloneOrReset,
      ensureWorktree,
      pathExists: vi.fn(async () => false),
    });
    await beforeAnalyze();

    expect(cloneOrReset).toHaveBeenCalledWith(
      webhookTarget.cloneUrl,
      webhookTarget.mainRepoPath,
      webhookTarget.branch,
    );
    expect(ensureWorktree).toHaveBeenCalledWith({
      mainRepoPath: webhookTarget.mainRepoPath,
      worktreePath: webhookTarget.repoPath,
      branch: webhookTarget.registryName,
      baseRef: `origin/${webhookTarget.branch}`,
      resetToRef: `origin/${webhookTarget.branch}`,
    });
  });

  it('keeps an existing main repository on its index branch', async () => {
    const cloneOrReset = vi.fn(async () => 'ok');
    const ensureWorktree = vi.fn(async () => ({}));
    const pathExists = vi.fn(async () => true);
    const webhookTarget = target({
      env: 'dev',
      repoPath: path.join(PROJECTS_ROOT, 'dev-imservice'),
      registryName: 'dev-imservice',
    });

    const beforeAnalyze = createWebhookBeforeAnalyze(webhookTarget, {
      cloneOrReset,
      ensureWorktree,
      pathExists,
    });
    await beforeAnalyze();

    expect(pathExists).toHaveBeenCalledWith(path.join(webhookTarget.mainRepoPath, '.git'));
    expect(cloneOrReset).not.toHaveBeenCalled();
    expect(ensureWorktree).toHaveBeenCalledWith({
      mainRepoPath: webhookTarget.mainRepoPath,
      worktreePath: webhookTarget.repoPath,
      branch: webhookTarget.registryName,
      baseRef: `origin/${webhookTarget.branch}`,
      resetToRef: `origin/${webhookTarget.branch}`,
    });
  });

  it('does nothing when cloneUrl is missing', async () => {
    const cloneOrReset = vi.fn(async () => 'ok');
    const ensureWorktree = vi.fn(async () => ({}));

    const beforeAnalyze = createWebhookBeforeAnalyze(target({ cloneUrl: undefined }), {
      cloneOrReset,
      ensureWorktree,
      pathExists: vi.fn(async () => false),
    });
    await beforeAnalyze();

    expect(cloneOrReset).not.toHaveBeenCalled();
    expect(ensureWorktree).not.toHaveBeenCalled();
  });
});

describe('shouldReconcileMissingWebhookTargets', () => {
  it('skips reconciliation on startup when replay is enabled', () => {
    expect(shouldReconcileMissingWebhookTargets('startup', true)).toBe(false);
  });

  it('reconciles on startup when replay is disabled', () => {
    expect(shouldReconcileMissingWebhookTargets('startup', false)).toBe(true);
  });

  it('reconciles on manual trigger regardless of replay', () => {
    expect(shouldReconcileMissingWebhookTargets('manual', true)).toBe(true);
    expect(shouldReconcileMissingWebhookTargets('manual', false)).toBe(true);
  });
});
