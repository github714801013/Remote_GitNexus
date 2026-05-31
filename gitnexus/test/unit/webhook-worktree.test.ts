import { execFile } from 'child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  WebhookWorktreeError,
  assertEnvAllowed,
  assertSafeGitRef,
  assertSafeSegment,
  buildGiteaWebhookAnalyzeOptions,
  buildRegistryName,
  copyBootstrapIndex,
  getGiteaWebhookRepoPath,
  getLegacyManagedWorktreePath,
  getManagedWorktreePath,
  parseGiteaWebhookRepo,
  parseAllowedEnvs,
  ensureLocalWorktree,
  upsertWebhookRepoConfig,
} from '../../src/server/webhook-worktree.js';

const git = (args: string[], cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const proc = execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout.trim());
      }
    });
    proc.stdin?.end();
  });

describe('webhook worktree helpers', () => {
  it('parses allowed envs and rejects envs outside the allow list', () => {
    const allowed = parseAllowedEnvs('dev, saas,,DEV');

    expect(allowed).toEqual(['dev', 'saas']);
    expect(() => assertEnvAllowed('dev', allowed)).not.toThrow();
    expect(() => assertEnvAllowed('prod', allowed)).toThrow(WebhookWorktreeError);
  });

  it('rejects unsafe path segments before they reach git commands', () => {
    expect(() => assertSafeSegment('feature-dev', 'branch')).not.toThrow();
    expect(() => assertSafeGitRef('origin/feature-dev', 'baseRef')).not.toThrow();
    expect(() => assertSafeSegment('../main', 'branch')).toThrow(WebhookWorktreeError);
    expect(() => assertSafeGitRef('../main', 'baseRef')).toThrow(WebhookWorktreeError);
    expect(() => assertSafeSegment('dev/api', 'projectName')).toThrow(WebhookWorktreeError);
    expect(() => assertSafeSegment('', 'projectName')).toThrow(WebhookWorktreeError);
  });

  it('parses legacy Gitea webhook payloads and maps them under the projects root', () => {
    const repo = parseGiteaWebhookRepo({
      repository: {
        full_name: 'oa-java/oa-order',
        clone_url: 'https://code.9ji.com/oa-java/oa-order.git',
      },
      ref: 'refs/heads/dev',
    });

    expect(repo).toEqual({
      fullName: 'oa-java/oa-order',
      cloneUrl: 'https://code.9ji.com/oa-java/oa-order.git',
      branch: 'dev',
    });
    expect(getGiteaWebhookRepoPath('/projects', repo.fullName)).toBe(
      path.join('/projects', 'oa-java', 'oa-order'),
    );
    expect(() => getGiteaWebhookRepoPath('/projects', '../oa-order')).toThrow(WebhookWorktreeError);
  });

  it('builds analyze registration options from the legacy Gitea branch', () => {
    expect(buildGiteaWebhookAnalyzeOptions('group-logistics/oa-stock', 'release_9ji')).toEqual({
      repoName: 'oa-stock',
      registryName: 'oa-stock',
      registryBranch: 'release_9ji',
    });
    expect(() => buildGiteaWebhookAnalyzeOptions('group-logistics/oa-stock', '../dev')).toThrow(
      WebhookWorktreeError,
    );
  });

  it('upserts legacy webhook repo config without dropping existing entries', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-webhook-config-test-'));
    const reposFile = path.join(tempRoot, 'repos.json');
    await writeFile(
      reposFile,
      JSON.stringify([{ full_name: 'oa-java/oa-order', clone_url: 'old', branch: 'master' }]),
    );

    await upsertWebhookRepoConfig(reposFile, {
      full_name: 'oa-java/oa-order',
      clone_url: 'https://code.9ji.com/oa-java/oa-order.git',
      branch: 'dev',
    });
    await upsertWebhookRepoConfig(reposFile, {
      full_name: 'Front-end/jiuji-m',
      clone_url: 'https://code.9ji.com/Front-end/jiuji-m.git',
    });

    const repos = JSON.parse(await readFile(reposFile, 'utf-8'));
    expect(repos).toEqual([
      {
        full_name: 'oa-java/oa-order',
        clone_url: 'https://code.9ji.com/oa-java/oa-order.git',
        branch: 'dev',
      },
      {
        full_name: 'Front-end/jiuji-m',
        clone_url: 'https://code.9ji.com/Front-end/jiuji-m.git',
        branch: 'master',
      },
    ]);
  });

  it('builds env-prefixed registry names and managed worktree paths', () => {
    const registryName = buildRegistryName('dev', 'api');
    const worktreePath = getManagedWorktreePath(
      path.join('/projects', 'oa-java', 'api'),
      'dev',
      'api',
    );

    expect(registryName).toBe('dev-api');
    expect(worktreePath).toBe(path.join('/projects', 'oa-java', 'dev-api'));
    expect(getLegacyManagedWorktreePath('dev', 'api')).toBe(
      path.join(os.homedir(), '.gitnexus', 'worktrees', 'dev-api'),
    );
  });

  it('resets an existing managed worktree to the requested source ref', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-worktree-reset-test-'));
    const remoteRepo = path.join(tempRoot, 'remote.git');
    const mainRepo = path.join(tempRoot, 'main');
    const worktree = path.join(tempRoot, 'dev-api');
    await mkdir(tempRoot, { recursive: true });
    await git(['init', '--bare', remoteRepo], tempRoot);
    await git(['clone', remoteRepo, mainRepo], tempRoot);
    await git(['config', 'user.email', 'gitnexus@example.com'], mainRepo);
    await git(['config', 'user.name', 'GitNexus Test'], mainRepo);
    await writeFile(path.join(mainRepo, 'app.txt'), 'one');
    await git(['add', 'app.txt'], mainRepo);
    await git(['commit', '-m', 'one'], mainRepo);
    await git(['push', 'origin', 'HEAD:master'], mainRepo);
    const firstCommit = await git(['rev-parse', 'HEAD'], mainRepo);

    const first = await ensureLocalWorktree({
      mainRepoPath: mainRepo,
      worktreePath: worktree,
      branch: 'dev-api',
      baseRef: 'origin/master',
      resetToRef: 'origin/master',
    });
    expect(first.commit).toBe(firstCommit);

    await writeFile(path.join(mainRepo, 'app.txt'), 'two');
    await git(['add', 'app.txt'], mainRepo);
    await git(['commit', '-m', 'two'], mainRepo);
    await git(['push', 'origin', 'HEAD:master'], mainRepo);
    const secondCommit = await git(['rev-parse', 'HEAD'], mainRepo);

    const second = await ensureLocalWorktree({
      mainRepoPath: mainRepo,
      worktreePath: worktree,
      branch: 'dev-api',
      baseRef: 'origin/master',
      resetToRef: 'origin/master',
    });

    expect(second.commit).toBe(secondCommit);
    expect(await git(['rev-parse', 'HEAD'], worktree)).toBe(secondCommit);
  });

  it('fetches the requested remote source before adding a new branch worktree', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-worktree-fetch-test-'));
    const remoteRepo = path.join(tempRoot, 'remote.git');
    const mainRepo = path.join(tempRoot, 'main');
    const worktree = path.join(tempRoot, 'dev-oanew');
    await mkdir(tempRoot, { recursive: true });
    await git(['init', '--bare', remoteRepo], tempRoot);
    await git(['clone', remoteRepo, mainRepo], tempRoot);
    await git(['config', 'user.email', 'gitnexus@example.com'], mainRepo);
    await git(['config', 'user.name', 'GitNexus Test'], mainRepo);
    await writeFile(path.join(mainRepo, 'app.txt'), 'depart');
    await git(['add', 'app.txt'], mainRepo);
    await git(['commit', '-m', 'depart'], mainRepo);
    await git(['push', 'origin', 'HEAD:master_depart_iteng'], mainRepo);
    await git(
      ['config', 'remote.origin.fetch', '+refs/heads/master:refs/remotes/origin/master'],
      mainRepo,
    );
    await git(['update-ref', '-d', 'refs/remotes/origin/master_depart_iteng'], mainRepo).catch(
      () => '',
    );
    const sourceCommit = await git(['rev-parse', 'HEAD'], mainRepo);

    const created = await ensureLocalWorktree({
      mainRepoPath: mainRepo,
      worktreePath: worktree,
      branch: 'dev-oanew',
      baseRef: 'origin/master_depart_iteng',
      resetToRef: 'origin/master_depart_iteng',
    });

    expect(created.commit).toBe(sourceCommit);
    expect(await git(['rev-parse', 'HEAD'], worktree)).toBe(sourceCommit);
  });

  it('copies a main index and rewrites meta for the worktree registry entry', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-worktree-test-'));
    const mainRepo = path.join(tempRoot, 'main');
    const worktree = path.join(tempRoot, 'worktree');
    await mkdir(path.join(mainRepo, '.gitnexus', 'lbug'), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(
      path.join(mainRepo, '.gitnexus', 'meta.json'),
      JSON.stringify({
        repoPath: mainRepo,
        branch: 'main',
        lastCommit: 'main-sha',
        indexedAt: '2026-01-01T00:00:00.000Z',
        remoteUrl: 'https://example.com/org/api.git',
        stats: { files: 1 },
      }),
    );

    const copied = await copyBootstrapIndex({
      sourceRepoPath: mainRepo,
      worktreePath: worktree,
      branch: 'feature-local',
      commit: 'feature-sha',
      registryName: 'dev-api',
      register: async (repoPath, meta, opts) => {
        expect(repoPath).toBe(worktree);
        expect(meta.repoPath).toBe(worktree);
        expect(meta.branch).toBe('feature-local');
        expect(meta.lastCommit).toBe('feature-sha');
        expect(opts?.name).toBe('dev-api');
        return opts?.name ?? 'missing';
      },
    });

    const meta = JSON.parse(await readFile(path.join(worktree, '.gitnexus', 'meta.json'), 'utf-8'));
    expect(copied).toBe(true);
    expect(meta.repoPath).toBe(worktree);
    expect(meta.branch).toBe('feature-local');
    expect(meta.lastCommit).toBe('feature-sha');
  });
});
