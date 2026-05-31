import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { RepoMeta } from '../storage/repo-manager.js';

export class WebhookWorktreeError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'WebhookWorktreeError';
  }
}

export const parseAllowedEnvs = (raw: string | undefined): string[] => {
  const values = new Set(
    (raw ?? '')
      .split(',')
      .map((env) => env.trim().toLowerCase())
      .filter(Boolean),
  );
  return [...values];
};

export const assertEnvAllowed = (env: string, allowedEnvs: string[]): void => {
  assertSafeSegment(env, 'env');
  if (!allowedEnvs.includes(env.toLowerCase())) {
    throw new WebhookWorktreeError(`Environment "${env}" is not allowed`, 403);
  }
};

export const assertSafeSegment = (value: string, fieldName: string): void => {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new WebhookWorktreeError(`Invalid "${fieldName}"`);
  }
  if (value === '.' || value === '..') {
    throw new WebhookWorktreeError(`Invalid "${fieldName}"`);
  }
};

export const assertSafeGitRef = (value: string, fieldName: string): void => {
  if (
    value.length === 0 ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('..') ||
    value.includes('\\') ||
    /[\x00-\x20~^:?*[]/.test(value) ||
    value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new WebhookWorktreeError(`Invalid "${fieldName}"`);
  }
};

export const buildRegistryName = (env: string, projectName: string): string => {
  assertSafeSegment(env, 'env');
  assertSafeSegment(projectName, 'projectName');
  return `${env.toLowerCase()}-${projectName}`;
};

export const getManagedWorktreePath = (
  mainRepoPath: string,
  env: string,
  projectName: string,
): string => {
  return path.join(path.dirname(mainRepoPath), buildRegistryName(env, projectName));
};

export const getLegacyManagedWorktreePath = (env: string, projectName: string): string => {
  return path.join(os.homedir(), '.gitnexus', 'worktrees', buildRegistryName(env, projectName));
};

export interface GiteaWebhookRepo {
  fullName: string;
  cloneUrl?: string;
  branch?: string;
}

export const parseGiteaWebhookRepo = (payload: unknown): GiteaWebhookRepo => {
  if (!payload || typeof payload !== 'object') {
    throw new WebhookWorktreeError('Invalid JSON payload');
  }
  const body = payload as Record<string, unknown>;
  const repository = body.repository;
  if (!repository || typeof repository !== 'object') {
    throw new WebhookWorktreeError('Repository full_name missing');
  }
  const repo = repository as Record<string, unknown>;
  const fullName = repo.full_name;
  if (typeof fullName !== 'string' || fullName.trim().length === 0) {
    throw new WebhookWorktreeError('Repository full_name missing');
  }
  const cloneUrl = repo.clone_url;
  if (cloneUrl !== undefined && typeof cloneUrl !== 'string') {
    throw new WebhookWorktreeError('Repository clone_url must be a string');
  }
  const ref = body.ref;
  const branch =
    typeof ref === 'string' && ref.startsWith('refs/heads/') ? ref.slice(11) : undefined;

  return {
    fullName: fullName.trim(),
    cloneUrl: typeof cloneUrl === 'string' ? cloneUrl.trim() || undefined : undefined,
    branch: branch?.trim() || undefined,
  };
};

export const getProjectsRoot = (): string => process.env.PROJECTS_ROOT || '/projects';

export const getGiteaWebhookRepoPath = (projectsRoot: string, fullName: string): string => {
  const segments = fullName.split('/');
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new WebhookWorktreeError('Invalid repository full_name');
  }
  for (const segment of segments) assertSafeSegment(segment, 'repository full_name');
  return path.join(projectsRoot, ...segments);
};

export interface WebhookRepoConfigEntry {
  full_name: string;
  clone_url?: string;
  branch?: string;
}

export interface WebhookAnalyzeRegistrationOptions {
  repoName: string;
  registryName: string;
  registryBranch: string;
}

export const buildGiteaWebhookAnalyzeOptions = (
  fullName: string,
  branch: string,
): WebhookAnalyzeRegistrationOptions => {
  const segments = fullName.split('/');
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new WebhookWorktreeError('Invalid repository full_name');
  }
  for (const segment of segments) assertSafeSegment(segment, 'repository full_name');
  assertSafeGitRef(branch, 'branch');

  const repoName = segments[segments.length - 1];
  return {
    repoName,
    registryName: repoName,
    registryBranch: branch,
  };
};

export const upsertWebhookRepoConfig = async (
  reposFile: string,
  entry: WebhookRepoConfigEntry,
): Promise<void> => {
  await fs.mkdir(path.dirname(reposFile), { recursive: true });
  let repos: WebhookRepoConfigEntry[] = [];
  try {
    const raw = await fs.readFile(reposFile, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) repos = parsed;
  } catch {
    repos = [];
  }

  const existing = repos.find((repo) => repo.full_name === entry.full_name);
  if (existing) {
    if (entry.clone_url) existing.clone_url = entry.clone_url;
    if (entry.branch) existing.branch = entry.branch;
  } else {
    repos.push({
      full_name: entry.full_name,
      clone_url: entry.clone_url,
      branch: entry.branch || 'master',
    });
  }

  await fs.writeFile(reposFile, JSON.stringify(repos, null, 2));
};

const pathExists = async (targetPath: string): Promise<boolean> =>
  fs.access(targetPath).then(
    () => true,
    () => false,
  );

const canonicalPath = async (targetPath: string): Promise<string> => {
  const realPath = await fs.realpath(targetPath);
  const normalized = path.normalize(realPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const runGit = (args: string[], cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: process.platform === 'win32' ? 'echo' : '/bin/true',
      },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new WebhookWorktreeError(`git ${args[0]} failed: ${stderr.trim()}`, 500));
      }
    });
    proc.on('error', (err) => {
      reject(new WebhookWorktreeError(`Failed to spawn git: ${err.message}`, 500));
    });
  });

const fetchOriginRef = async (ref: string | undefined, cwd: string): Promise<void> => {
  if (!ref?.startsWith('origin/')) return;
  const branch = ref.slice('origin/'.length);
  await runGit(['fetch', 'origin', `${branch}:refs/remotes/origin/${branch}`, '--depth', '1'], cwd);
};

export interface EnsureWorktreeParams {
  mainRepoPath: string;
  worktreePath: string;
  branch: string;
  baseRef?: string;
  resetToRef?: string;
}

export interface EnsureWorktreeResult {
  worktreePath: string;
  branch: string;
  commit: string;
}

export const ensureLocalWorktree = async (
  params: EnsureWorktreeParams,
): Promise<EnsureWorktreeResult> => {
  assertSafeGitRef(params.branch, 'branch');
  if (params.baseRef) assertSafeGitRef(params.baseRef, 'baseRef');
  if (params.resetToRef) assertSafeGitRef(params.resetToRef, 'resetToRef');

  if (await pathExists(params.worktreePath)) {
    const gitDir = await runGit(['rev-parse', '--show-toplevel'], params.worktreePath);
    const [gitRealPath, worktreeRealPath] = await Promise.all([
      canonicalPath(gitDir),
      canonicalPath(params.worktreePath),
    ]);
    if (gitRealPath !== worktreeRealPath) {
      throw new WebhookWorktreeError('Managed worktree path points at a different repository', 409);
    }
  } else {
    await fs.mkdir(path.dirname(params.worktreePath), { recursive: true });
    const hasBranch = await runGit(['branch', '--list', params.branch], params.mainRepoPath);
    await fetchOriginRef(params.baseRef, params.mainRepoPath);
    const args = hasBranch
      ? ['worktree', 'add', params.worktreePath, params.branch]
      : ['worktree', 'add', '-b', params.branch, params.worktreePath, params.baseRef ?? 'main'];
    await runGit(args, params.mainRepoPath);
  }

  const currentBranch = await runGit(['branch', '--show-current'], params.worktreePath);
  if (currentBranch !== params.branch) {
    throw new WebhookWorktreeError('Managed worktree path uses a different branch', 409);
  }
  if (params.resetToRef) {
    if (params.resetToRef.startsWith('origin/')) {
      await fetchOriginRef(params.resetToRef, params.worktreePath);
      await runGit(['reset', '--hard', 'FETCH_HEAD'], params.worktreePath);
    } else {
      await runGit(['reset', '--hard', params.resetToRef], params.worktreePath);
    }
    await runGit(['clean', '-fd', '-e', '.gitnexus', '-e', '.gitnexus/'], params.worktreePath);
  }
  const commit = await runGit(['rev-parse', 'HEAD'], params.worktreePath);
  return { worktreePath: params.worktreePath, branch: currentBranch, commit };
};

export interface CopyBootstrapIndexParams {
  sourceRepoPath: string;
  worktreePath: string;
  branch: string;
  commit: string;
  registryName: string;
  register: (
    repoPath: string,
    meta: RepoMeta,
    opts?: { name?: string; allowDuplicateName?: boolean },
  ) => Promise<string>;
}

export const copyBootstrapIndex = async (params: CopyBootstrapIndexParams): Promise<boolean> => {
  const sourceIndex = path.join(params.sourceRepoPath, '.gitnexus');
  const sourceMetaPath = path.join(sourceIndex, 'meta.json');
  const sourceLbugPath = path.join(sourceIndex, 'lbug');
  if (!(await pathExists(sourceMetaPath)) || !(await pathExists(sourceLbugPath))) {
    return false;
  }

  const targetIndex = path.join(params.worktreePath, '.gitnexus');
  await fs.rm(targetIndex, { recursive: true, force: true });
  await fs.cp(sourceIndex, targetIndex, { recursive: true });

  const meta = JSON.parse(
    await fs.readFile(path.join(targetIndex, 'meta.json'), 'utf-8'),
  ) as RepoMeta;
  const updatedMeta: RepoMeta = {
    ...meta,
    repoPath: params.worktreePath,
    branch: params.branch,
    lastCommit: params.commit,
    indexedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(targetIndex, 'meta.json'), JSON.stringify(updatedMeta, null, 2));
  await params.register(params.worktreePath, updatedMeta, { name: params.registryName });
  return true;
};
