import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildWebhookBranchByPath,
  isKnownBranchMismatch,
  type WebhookBranchSource,
} from '../../src/server/stale-analyze-scheduler.js';

// 远端真实快照（2026-11-08）：worktree 的 checkout/索引分支是 dev-<project>，
// 而 repos.<env>.json 登记的是源分支。巡检若用源分支覆盖，13 个 worktree 全被跳过。
const worktree: WebhookBranchSource = {
  repoPath: '/projects/oa-java/dev-oa-order',
  branch: 'dev',
  env: 'dev',
};
const branchWorktree: WebhookBranchSource = {
  repoPath: '/projects/9ji_APP_iOS/dev-OA',
  branch: 'develop',
  env: 'dev',
};
const mainRepo: WebhookBranchSource = {
  repoPath: '/projects/oa-java/oa-order',
  branch: 'release_9ji',
};

describe('index health check branch resolution', () => {
  it('does not let the webhook source branch override a worktree index branch', () => {
    const map = buildWebhookBranchByPath([worktree, branchWorktree, mainRepo]);

    expect(map.has(path.resolve(worktree.repoPath))).toBe(false);
    expect(map.has(path.resolve(branchWorktree.repoPath))).toBe(false);
    expect(map.get(path.resolve(mainRepo.repoPath))).toBe('release_9ji');
  });

  it('keeps a worktree eligible when the registry branch matches its checkout', () => {
    const map = buildWebhookBranchByPath([worktree]);

    const registryBranch = map.get(path.resolve(worktree.repoPath)) ?? 'dev-oa-order';

    expect(isKnownBranchMismatch('dev-oa-order', registryBranch)).toBe(false);
  });

  it('still skips a main repo whose index branch differs from its checkout', () => {
    const map = buildWebhookBranchByPath([mainRepo]);

    const registryBranch = map.get(path.resolve(mainRepo.repoPath)) ?? 'dev';

    expect(isKnownBranchMismatch('dev', registryBranch)).toBe(true);
  });
});

// 巡检是 createServer 内的闭包，无法注入；这里沿用仓库既有的源码契约断言
// （同 api-index-health-check-async.test.ts），只锁定位与存在性，不覆盖运行时行为。
describe('index health check failure quarantine', () => {
  it('retries failed repositories on the next round instead of for the process lifetime', async () => {
    const source = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'server', 'api.ts'),
      'utf8',
    );
    const loopStart = source.indexOf('const runIndexHealthCheck = async');
    const loopEnd = source.indexOf("app.post('/api/index-health-check'", loopStart);
    const loop = source.slice(loopStart, loopEnd);

    expect(loopStart).toBeGreaterThanOrEqual(0);
    expect(loopEnd).toBeGreaterThan(loopStart);
    expect(loop).toContain('staleAnalyzeFailedRepoPaths.clear()');
  });
});
