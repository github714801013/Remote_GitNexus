import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 测试夹具使用本地 file:// 仓库；URL 校验与分支切换行为无关，仅放行该夹具。
vi.mock('../../src/core/net/url-guard.js', () => ({
  validateGitUrl: () => {},
}));

import { cloneOrResetToBranch } from '../../src/server/git-clone.js';
import { ensureLocalWorktree, prepareWebhookWorktree } from '../../src/server/webhook-worktree.js';
import { createWebhookBeforeAnalyze } from '../../src/server/webhook-repo-reconciler.js';
import { isKnownBranchMismatch } from '../../src/server/stale-analyze-scheduler.js';
import { getCurrentBranchAsync } from '../../src/storage/git.js';

describe('env webhook preparation vs main repo index branch', () => {
  let root: string;
  let origin: string;
  let mainRepo: string;
  let worktreePath: string;
  let devCommit: string;

  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  const commit = (cwd: string, message: string) => {
    git(
      [
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@test',
        '-c',
        'commit.gpgSign=false',
        'commit',
        '--allow-empty',
        '-m',
        message,
      ],
      cwd,
    );
    return git(['rev-parse', 'HEAD'], cwd);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-branch-mismatch-'));
    origin = path.join(root, 'origin.git');
    mainRepo = path.join(root, 'main');
    worktreePath = path.join(root, 'dev-project');
    const seed = path.join(root, 'seed');

    git(['init', '--bare', '--initial-branch=release_9ji', origin], root);
    fs.mkdirSync(seed);
    git(['init', '--initial-branch=release_9ji', seed], root);
    commit(seed, 'release baseline');
    const originUrl = pathToFileURL(origin).href;
    git(['remote', 'add', 'origin', originUrl], seed);
    git(['push', 'origin', 'release_9ji'], seed);
    git(['checkout', '-b', 'dev'], seed);
    devCommit = commit(seed, 'dev change');
    git(['push', 'origin', 'dev'], seed);

    git(['clone', originUrl, mainRepo], root);
    expect(git(['branch', '--show-current'], mainRepo)).toBe('release_9ji');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps the main clone on its index branch when the env route prepares a worktree', async () => {
    const worktree = await prepareWebhookWorktree(
      {
        cloneUrl: pathToFileURL(origin).href,
        mainRepoPath: mainRepo,
        worktreePath,
        sourceBranch: 'dev',
        registryName: 'dev-project',
      },
      {
        cloneOrReset: cloneOrResetToBranch,
        ensureWorktree: ensureLocalWorktree,
        pathExists: async () => true,
      },
    );

    expect(worktree.branch).toBe('dev-project');
    expect(worktree.commit).toBe(devCommit);

    const currentBranch = await getCurrentBranchAsync(mainRepo);
    expect(currentBranch).toBe('release_9ji');
    expect(isKnownBranchMismatch(currentBranch, 'release_9ji')).toBe(false);
  });

  it('leaves the main clone on its index branch after preparing an env worktree', async () => {
    const beforeAnalyze = createWebhookBeforeAnalyze(
      {
        fullName: 'acme/project',
        repoPath: worktreePath,
        mainRepoPath: mainRepo,
        cloneUrl: pathToFileURL(origin).href,
        branch: 'dev',
        repoName: 'project',
        registryName: 'dev-project',
        env: 'dev',
      },
      {
        cloneOrReset: cloneOrResetToBranch,
        ensureWorktree: ensureLocalWorktree,
        pathExists: async () => true,
      },
    );

    await beforeAnalyze();

    // env worktree 必须仍正常创建在 dev 提交上。
    expect(git(['branch', '--show-current'], worktreePath)).toBe('dev-project');
    expect(git(['rev-parse', 'HEAD'], worktreePath)).toBe(devCommit);

    // 主仓索引分支是 release_9ji；env 预处理不得把主仓留在 dev 上。
    const currentBranch = await getCurrentBranchAsync(mainRepo);
    expect(currentBranch).toBe('release_9ji');
    expect(isKnownBranchMismatch(currentBranch, 'release_9ji')).toBe(false);
  });
});
