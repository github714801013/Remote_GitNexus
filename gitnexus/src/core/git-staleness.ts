/**
 * Git working tree vs index commit staleness (used by MCP resources, group status, etc.).
 * Lives in core/ so application code does not depend on the MCP package layer.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'path';
import { buildGitEnv } from './git-auth.js';
import { readRegistry, type RegistryEntry, type CwdMatch } from '../storage/repo-manager.js';
import { findGitRootByDotGit, getCurrentCommit, getRemoteUrl } from '../storage/git.js';

const execFileAsync = promisify(execFile);

export type StalenessStatus = 'fresh' | 'stale' | 'unknown';

export interface StalenessInfo {
  /** `unknown` means the indexed commit could not be compared safely. */
  status: StalenessStatus;
  /** Backward-compatible field. Consumers must use `status` to distinguish unknown from fresh. */
  isStale: boolean;
  commitsBehind: number | null;
  indexedCommit: string;
  checkoutCommit?: string;
  branch?: string;
  upstreamRef?: string;
  reason?: 'git_unavailable' | 'indexed_commit_unreachable' | 'checkout_unavailable' | 'unknown';
  hint?: string;
}

export interface RemoteSyncInfo {
  checked: boolean;
  reset: boolean;
  localCommit?: string;
  remoteCommit?: string;
  upstreamRef?: string;
  reason?: string;
}

const gitOutput = async (
  args: string[],
  repoPath: string,
  url?: string,
): Promise<string> => {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    windowsHide: true,
    env: buildGitEnv(process.env, { url }),
  });
  return stdout.trim();
};

const inspectCheckout = (
  repoPath: string,
): Pick<StalenessInfo, 'checkoutCommit' | 'branch' | 'upstreamRef'> => {
  const read = (args: string[]): string | undefined => {
    try {
      const value = execFileSync('git', args, {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }).trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  };
  const checkoutCommit = read(['rev-parse', 'HEAD']);
  const branch = read(['branch', '--show-current']);
  const upstreamRef = read(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  return {
    ...(checkoutCommit ? { checkoutCommit } : {}),
    ...(branch ? { branch } : {}),
    ...(upstreamRef ? { upstreamRef } : {}),
  };
};

const unknownStaleness = (
  indexedCommit: string,
  reason: StalenessInfo['reason'],
  checkout?: Pick<StalenessInfo, 'checkoutCommit' | 'branch' | 'upstreamRef'>,
): StalenessInfo => ({
  status: 'unknown',
  isStale: false,
  commitsBehind: null,
  indexedCommit,
  ...checkout,
  reason,
  hint: 'Unable to compare the indexed commit with the current checkout. Check the branch, shallow clone, or repository path.',
});

const resolvedStaleness = (
  indexedCommit: string,
  checkout: Required<Pick<StalenessInfo, 'checkoutCommit'>> &
    Pick<StalenessInfo, 'branch' | 'upstreamRef'>,
  commitsBehind: number,
): StalenessInfo =>
  commitsBehind > 0
    ? {
        status: 'stale',
        isStale: true,
        commitsBehind,
        indexedCommit,
        ...checkout,
        hint: `⚠️ Index is ${commitsBehind} commit${commitsBehind > 1 ? 's' : ''} behind HEAD. Run analyze tool to update.`,
      }
    : {
        status: 'fresh',
        isStale: false,
        commitsBehind: 0,
        indexedCommit,
        ...checkout,
      };

/**
 * 检查索引项目当前分支的 upstream，并在远端有更新时强制同步工作树。
 * 不执行 git clean，因此未跟踪文件会被保留；失败时返回降级结果。
 */
export async function syncWithUpstream(repoPath: string): Promise<RemoteSyncInfo> {
  try {
    const upstreamRef = await gitOutput(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      repoPath,
    );
    const separator = upstreamRef.indexOf('/');
    if (separator <= 0 || separator === upstreamRef.length - 1) {
      return { checked: false, reset: false, reason: 'upstream ref is unavailable' };
    }

    const remote = upstreamRef.slice(0, separator);
    const branch = upstreamRef.slice(separator + 1);
    const remoteUrl = await gitOutput(['remote', 'get-url', remote], repoPath);
    const remoteCommit = await gitOutput(
      ['ls-remote', remote, `refs/heads/${branch}`],
      repoPath,
      remoteUrl,
    );
    const remoteHash = remoteCommit.split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/i.test(remoteHash)) {
      return { checked: false, reset: false, upstreamRef, reason: 'remote branch was not found' };
    }

    const localCommit = await gitOutput(['rev-parse', 'HEAD'], repoPath);
    if (localCommit === remoteHash) {
      return { checked: true, reset: false, localCommit, remoteCommit: remoteHash, upstreamRef };
    }

    await gitOutput(['fetch', '--prune', remote], repoPath, remoteUrl);
    await gitOutput(['reset', '--hard', upstreamRef], repoPath, remoteUrl);
    const syncedCommit = await gitOutput(['rev-parse', 'HEAD'], repoPath);
    return {
      checked: true,
      reset: syncedCommit === remoteHash,
      localCommit,
      remoteCommit: remoteHash,
      upstreamRef,
    };
  } catch (error) {
    return {
      checked: false,
      reset: false,
      reason: error instanceof Error ? error.message : 'remote sync failed',
    };
  }
}


export function checkStaleness(repoPath: string, lastCommit: string): StalenessInfo {
  const checkout = inspectCheckout(repoPath);
  if (!checkout.checkoutCommit) return unknownStaleness(lastCommit, 'checkout_unavailable', checkout);
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', lastCommit, 'HEAD'], {
      cwd: repoPath,
      stdio: 'ignore',
      windowsHide: true,
    });
    const result = execFileSync('git', ['rev-list', '--count', `${lastCommit}..HEAD`], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();

    const commitsBehind = Number.parseInt(result, 10);
    if (!Number.isFinite(commitsBehind) || commitsBehind < 0) {
      return unknownStaleness(lastCommit, 'unknown', checkout);
    }

    return resolvedStaleness(lastCommit, checkout as Required<Pick<StalenessInfo, 'checkoutCommit'>>, commitsBehind);
  } catch {
    return unknownStaleness(lastCommit, 'indexed_commit_unreachable', checkout);
  }
}

/**
 * Async variant of {@link checkStaleness} — spawns git as a child process
 * instead of blocking the event loop.  Used by `listRepos()` to check many
 * repos in parallel (issue #1363: 200 repos × sync spawn ≈ 50 s).
 */
export async function checkStalenessAsync(
  repoPath: string,
  lastCommit: string,
): Promise<StalenessInfo> {
  try {
    const [head, branch, upstream] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf-8',
        windowsHide: true,
      }),
      execFileAsync('git', ['branch', '--show-current'], {
        cwd: repoPath,
        encoding: 'utf-8',
        windowsHide: true,
      }).catch(() => ({ stdout: '' })),
      execFileAsync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
        cwd: repoPath,
        encoding: 'utf-8',
        windowsHide: true,
      }).catch(() => ({ stdout: '' })),
    ]);
    const checkoutCommit = head.stdout.trim();
    const checkout = {
      ...(checkoutCommit ? { checkoutCommit } : {}),
      ...(branch.stdout.trim() ? { branch: branch.stdout.trim() } : {}),
      ...(upstream.stdout.trim() ? { upstreamRef: upstream.stdout.trim() } : {}),
    };
    if (!checkoutCommit) return unknownStaleness(lastCommit, 'checkout_unavailable', checkout);

    await execFileAsync('git', ['merge-base', '--is-ancestor', lastCommit, 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
      windowsHide: true,
    });
    const count = await execFileAsync('git', ['rev-list', '--count', `${lastCommit}..HEAD`], {
      cwd: repoPath,
      encoding: 'utf-8',
      windowsHide: true,
    });
    const commitsBehind = Number.parseInt(count.stdout.trim(), 10);
    if (!Number.isFinite(commitsBehind) || commitsBehind < 0) {
      return unknownStaleness(lastCommit, 'unknown', checkout);
    }
    return resolvedStaleness(
      lastCommit,
      checkout as Required<Pick<StalenessInfo, 'checkoutCommit'>>,
      commitsBehind,
    );
  } catch {
    return unknownStaleness(lastCommit, 'indexed_commit_unreachable');
  }
}

/**
 * Compare a sibling-clone HEAD against an indexed `lastCommit`. Returns
 * `undefined` when the indexed commit is not reachable from the sibling
 * (e.g. divergent branches, shallow clone, missing ref). The caller
 * should treat `undefined` as "drift unknown" rather than "no drift".
 */
function commitsAheadOfIndexed(siblingPath: string, indexedCommit: string): number | undefined {
  if (!indexedCommit) return undefined;
  try {
    const result = execFileSync('git', ['rev-list', '--count', `${indexedCommit}..HEAD`], {
      cwd: siblingPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    return parseInt(result, 10) || 0;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a working directory against the global registry. Returns:
 *   - `match: 'path'`              when `cwd` is inside a registered entry's path
 *   - `match: 'sibling-by-remote'` when `cwd` lives in a different on-disk clone
 *                                   of the same repo (same `remoteUrl`)
 *   - `match: 'none'`              when neither match applies
 *
 * For sibling-by-remote matches, the caller's HEAD and the drift vs the
 * indexed `lastCommit` are also returned so the MCP layer can warn
 * before serving silently-stale answers (issue: silent graph drift
 * across sibling clones).
 *
 * `path` matches deliberately use the longest-prefix rule so a cwd
 * inside a sub-path of a registered repo still matches that repo, not
 * a coincidentally-aliased shorter entry.
 */
export async function checkCwdMatch(cwd: string): Promise<CwdMatch> {
  const entries = await readRegistry();
  if (entries.length === 0) return { match: 'none' };

  const isWin = process.platform === 'win32';
  const norm = (p: string) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));
  const sep = path.sep;
  const cwdResolved = path.resolve(cwd);
  const cwdNorm = norm(cwdResolved);

  // 1) Path-based match (longest prefix wins, boundary-safe).
  let bestPath: RegistryEntry | undefined;
  let bestLen = -1;
  for (const e of entries) {
    const p = norm(e.path);
    if (cwdNorm === p || cwdNorm.startsWith(p.endsWith(sep) ? p : p + sep)) {
      if (p.length > bestLen) {
        bestPath = e;
        bestLen = p.length;
      }
    }
  }
  if (bestPath) return { match: 'path', entry: bestPath };

  // 2) Sibling-by-remote: locate the cwd's git root using only ancestor
  //    `.git` checks before shelling out. This keeps MCP startup from
  //    running git in an unrelated launch cwd such as $HOME (#1138).
  const cwdGitRoot = findGitRootByDotGit(cwdResolved);
  if (!cwdGitRoot) return { match: 'none' };

  const cwdRemote = getRemoteUrl(cwdGitRoot);
  if (!cwdRemote) return { match: 'none' };

  const sibling = entries.find(
    (e) => e.remoteUrl === cwdRemote && norm(e.path) !== norm(cwdGitRoot),
  );
  if (!sibling) return { match: 'none' };

  const cwdHead = getCurrentCommit(cwdGitRoot) || undefined;
  const drift = commitsAheadOfIndexed(cwdGitRoot, sibling.lastCommit);

  // Same commit on both clones → still report match=sibling-by-remote
  // (the relationship is real and useful to callers like list_repos /
  // future tooling) but leave `hint` unset: there's nothing to warn
  // about, and `maybeWarnSiblingDrift` already short-circuits this
  // case independently. Surfacing a no-op hint would force callers
  // to second-guess whether they need to display it.
  let hint: string | undefined;
  if (cwdHead && cwdHead === sibling.lastCommit) {
    hint = undefined;
  } else if (drift && drift > 0) {
    hint =
      `⚠️ Index for "${sibling.name}" was built at ${sibling.path}; ` +
      `your cwd (${cwdGitRoot}) is a sibling clone that is ${drift} commit${drift > 1 ? 's' : ''} ` +
      `ahead of the indexed commit. Results may be stale or incorrect — re-run \`gitnexus analyze\` ` +
      `to refresh the index.`;
  } else {
    hint =
      `⚠️ Index for "${sibling.name}" was built at ${sibling.path}; ` +
      `your cwd (${cwdGitRoot}) is a sibling clone whose HEAD differs from the indexed commit. ` +
      `Results may be stale or incorrect — re-run \`gitnexus analyze\` to refresh the index.`;
  }

  return {
    match: 'sibling-by-remote',
    entry: sibling,
    cwdGitRoot,
    cwdHead,
    drift,
    hint,
  };
}
