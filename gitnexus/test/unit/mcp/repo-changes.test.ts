import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

const { repoManagerMocks } = vi.hoisted(() => ({
  repoManagerMocks: {
    listRegisteredRepos: vi.fn(),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    loadMeta: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@ladybugdb/core', () => ({
  default: {},
}));

vi.mock('../../../src/storage/repo-manager.js', () => repoManagerMocks);

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn().mockResolvedValue(undefined),
  executeQuery: vi.fn().mockResolvedValue([]),
  executeParameterized: vi.fn().mockResolvedValue([]),
  closeLbug: vi.fn().mockResolvedValue(undefined),
  isLbugReady: vi.fn().mockReturnValue(true),
}));

vi.mock('../../../src/core/lbug/lbug-adapter.js', () => ({
  executeQuery: vi.fn().mockResolvedValue([]),
  executePrepared: vi.fn().mockResolvedValue([]),
  executeParameterized: vi.fn().mockResolvedValue([]),
  executeWithReusedStatement: vi.fn().mockResolvedValue([]),
  withLbugDb: vi.fn(async (_path, fn) => fn()),
  closeLbug: vi.fn().mockResolvedValue(undefined),
  isReadOnlyDbError: vi.fn().mockReturnValue(false),
}));

import { LocalBackend } from '../../../src/mcp/local/local-backend.js';

const BRANCH = 'main';
const INDEXED_AT = '2026-06-14T00:00:00.000Z';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function writeFile(repoPath: string, relPath: string, content: string): void {
  const full = path.join(repoPath, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

function commit(repoPath: string, message: string): string {
  execFileSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'ignore' });
  git(
    ['-c', 'user.name=Test Dev', '-c', 'user.email=test@example.com', 'commit', '-m', message],
    repoPath,
  );
  return git(['rev-parse', 'HEAD'], repoPath);
}

describe('LocalBackend repo_changes tool', () => {
  let tmpDir: string;
  let repoPath: string;
  let baseCommit: string;
  let outsideOnlyCommit: string;
  let indexedCommit: string;
  let sideCommit: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-repo-changes-'));
    repoPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
    git(['init', '-b', BRANCH], repoPath);

    const v1 = (name: string) => `export const ${name} = 1;\n`;
    const v2 = (name: string) => `export const ${name} = 2;\n`;
    const baseFiles: Array<[string, string]> = [
      ['src/a.ts', 'a'],
      ['src/modified.ts', 'modified'],
      ['src/deleted.ts', 'deleted'],
      ['src/reverted.ts', 'reverted'],
      ['src/deleteThenAdd.ts', 'deleteThenAdd'],
      // Same path prefix, different directory: only the first is inside `src/nested`.
      ['src/nested/inside.ts', 'inside'],
      ['src/nestedOther/outside.ts', 'outside'],
    ];
    for (const [relPath, name] of baseFiles) writeFile(repoPath, relPath, v1(name));
    baseCommit = commit(repoPath, 'base');

    writeFile(repoPath, 'src/a.ts', v2('a'));
    commit(repoPath, 'change a');

    writeFile(repoPath, 'src/modified.ts', v2('modified'));
    commit(repoPath, 'modify modified');

    fs.rmSync(path.join(repoPath, 'src/deleted.ts'));
    commit(repoPath, 'delete deleted');

    // Touched twice, ending back at the original content.
    writeFile(repoPath, 'src/reverted.ts', v2('reverted'));
    commit(repoPath, 'change reverted');
    writeFile(repoPath, 'src/reverted.ts', v1('reverted'));
    commit(repoPath, 'revert reverted');

    writeFile(repoPath, 'src/added.ts', v1('added'));
    commit(repoPath, 'add added');

    // Added and then modified: the last operation wins.
    writeFile(repoPath, 'src/addedThenModified.ts', v1('addedThenModified'));
    commit(repoPath, 'add addedThenModified');
    writeFile(repoPath, 'src/addedThenModified.ts', v2('addedThenModified'));
    commit(repoPath, 'modify addedThenModified');

    // Deleted and then re-created with the original content.
    fs.rmSync(path.join(repoPath, 'src/deleteThenAdd.ts'));
    commit(repoPath, 'delete deleteThenAdd');
    writeFile(repoPath, 'src/deleteThenAdd.ts', v1('deleteThenAdd'));
    commit(repoPath, 're-add deleteThenAdd');

    writeFile(repoPath, 'src/nested/inside.ts', v2('inside'));
    outsideOnlyCommit = commit(repoPath, 'modify nested inside');

    writeFile(repoPath, 'src/nestedOther/outside.ts', v2('outside'));
    indexedCommit = commit(repoPath, 'modify nestedOther outside');

    // A commit that exists in the repository but not on this branch's history.
    git(['checkout', '-q', '-b', 'side'], repoPath);
    writeFile(repoPath, 'src/side.ts', v1('side'));
    sideCommit = commit(repoPath, 'side work');
    git(['checkout', '-q', BRANCH], repoPath);

    repoManagerMocks.listRegisteredRepos.mockResolvedValue([
      {
        name: 'sample',
        path: repoPath,
        storagePath: path.join(tmpDir, 'storage'),
        indexedAt: INDEXED_AT,
        lastCommit: indexedCommit,
        stats: { files: 8, nodes: 8, communities: 0, processes: 0 },
      },
    ]);
    repoManagerMocks.loadMeta.mockResolvedValue({
      branch: BRANCH,
      indexedAt: INDEXED_AT,
      lastCommit: indexedCommit,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports an explicit no-change result against the indexed version, without touching the repository', async () => {
    const backend = new LocalBackend();
    const statusBefore = git(['status', '--porcelain'], repoPath);
    const headBefore = git(['rev-parse', 'HEAD'], repoPath);

    const out = await backend.callTool('repo_changes', {
      repo: 'sample',
      branch: BRANCH,
      since: indexedCommit,
    });

    expect(out).toEqual(
      expect.objectContaining({
        state: 'ok',
        current_commit: indexedCommit,
        index_freshness: INDEXED_AT,
        files: [],
        truncated: false,
      }),
    );
    expect(git(['status', '--porcelain'], repoPath)).toBe(statusBefore);
    expect(git(['rev-parse', 'HEAD'], repoPath)).toBe(headBefore);
  });

  it('reports the union of per-commit changes, keeping files that were changed and reverted', async () => {
    const backend = new LocalBackend();

    const out = await backend.callTool('repo_changes', {
      repo: 'sample',
      branch: BRANCH,
      since: baseCommit,
    });

    expect(out.state).toBe('ok');
    expect(out.files).toEqual(
      expect.arrayContaining([
        { path: 'src/a.ts', change_type: 'modified' },
        { path: 'src/modified.ts', change_type: 'modified' },
        { path: 'src/deleted.ts', change_type: 'deleted' },
        { path: 'src/reverted.ts', change_type: 'modified' },
        { path: 'src/added.ts', change_type: 'added' },
        { path: 'src/addedThenModified.ts', change_type: 'modified' },
        { path: 'src/deleteThenAdd.ts', change_type: 'added' },
        { path: 'src/nested/inside.ts', change_type: 'modified' },
        { path: 'src/nestedOther/outside.ts', change_type: 'modified' },
      ]),
    );
    // One entry per path: the union is de-duplicated.
    expect(out.files).toHaveLength(9);
  });

  it('filters by path-segment boundary and reports no changes when only out-of-scope files moved', async () => {
    const backend = new LocalBackend();

    const scoped = await backend.callTool('repo_changes', {
      repo: 'sample',
      branch: BRANCH,
      since: baseCommit,
      paths: ['src/nested'],
    });

    // `src/nested` matches its own files, never the sibling `src/nestedOther`.
    expect(scoped.files).toEqual([{ path: 'src/nested/inside.ts', change_type: 'modified' }]);

    const outOfScope = await backend.callTool('repo_changes', {
      repo: 'sample',
      branch: BRANCH,
      since: outsideOnlyCommit,
      paths: ['src/nested'],
    });

    expect(outOfScope.state).toBe('ok');
    expect(outOfScope.files).toEqual([]);
  });

  it('reports an unknown baseline without a change list when the baseline commit is missing', async () => {
    const backend = new LocalBackend();

    const out = await backend.callTool('repo_changes', {
      repo: 'sample',
      branch: BRANCH,
      since: '0'.repeat(40),
    });

    expect(out).toMatchObject({
      state: 'unknown',
      reason: 'baseline_not_found',
      current_commit: indexedCommit,
      index_freshness: INDEXED_AT,
    });
    // An empty list must never stand in for "cannot tell".
    expect(out).not.toHaveProperty('files');
  });

  it('reports an unknown baseline when the baseline commit is not an ancestor of the indexed version', async () => {
    const backend = new LocalBackend();

    const out = await backend.callTool('repo_changes', {
      repo: 'sample',
      branch: BRANCH,
      since: sideCommit,
    });

    expect(out).toMatchObject({ state: 'unknown', reason: 'baseline_not_found' });
    expect(out).not.toHaveProperty('files');
  });

  it('reports an unknown result naming the unrelated-branch cause when the branch has no index', async () => {
    const backend = new LocalBackend();

    const out = await backend.callTool('repo_changes', {
      repo: 'sample',
      branch: 'feature-x',
      since: baseCommit,
    });

    expect(out).toMatchObject({
      state: 'unknown',
      reason: 'repo_not_indexed',
      current_commit: null,
      index_freshness: null,
    });
    expect(out).not.toHaveProperty('files');
  });

  it('distinguishes an unusable `since` from a failed query in the message', async () => {
    const backend = new LocalBackend();

    const unusable = await backend.callTool('repo_changes', {
      repo: 'sample',
      branch: BRANCH,
      since: '2026-01-01T00:00:00Z',
    });
    expect(unusable).toMatchObject({ state: 'unknown', reason: 'query_failed' });
    expect(unusable).not.toHaveProperty('files');
    expect(unusable.message).toMatch(/commit hash/i);

    // The indexed version is gone from the repository: the query itself fails.
    repoManagerMocks.loadMeta.mockResolvedValue({
      branch: BRANCH,
      indexedAt: INDEXED_AT,
      lastCommit: 'f'.repeat(40),
    });
    const failed = await backend.callTool('repo_changes', {
      repo: 'sample',
      branch: BRANCH,
      since: baseCommit,
    });
    expect(failed).toMatchObject({ state: 'unknown', reason: 'query_failed' });
    expect(failed).not.toHaveProperty('files');
    expect(failed.message).not.toMatch(/commit hash/i);
    expect(failed.message).toMatch(/git/i);
  });

  it('answers against the indexed version even when the branch has moved ahead of it', async () => {
    // The index still points at `outsideOnlyCommit`; the branch tip is newer.
    repoManagerMocks.loadMeta.mockResolvedValue({
      branch: BRANCH,
      indexedAt: INDEXED_AT,
      lastCommit: outsideOnlyCommit,
    });
    const backend = new LocalBackend();

    const out = await backend.callTool('repo_changes', {
      repo: 'sample',
      branch: BRANCH,
      since: baseCommit,
    });

    expect(out).toMatchObject({
      state: 'ok',
      current_commit: outsideOnlyCommit,
      index_freshness: INDEXED_AT,
    });
    // The commit that only exists past the indexed version is not reported.
    expect(out.files).not.toContainEqual({
      path: 'src/nestedOther/outside.ts',
      change_type: 'modified',
    });
  });
});

describe('LocalBackend repo_changes truncation', () => {
  const BULK_REPO = 'bulk';
  let tmpDir: string;
  let repoPath: string;
  let baseCommit: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-repo-changes-bulk-'));
    repoPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
    git(['init', '-b', BRANCH], repoPath);

    writeFile(repoPath, 'src/seed.ts', 'export const seed = 1;\n');
    baseCommit = commit(repoPath, 'base');

    for (let i = 0; i < 1001; i += 1) {
      writeFile(repoPath, `src/bulk/f${i}.ts`, `export const f${i} = 1;\n`);
    }
    const indexedCommit = commit(repoPath, 'bulk');

    repoManagerMocks.listRegisteredRepos.mockResolvedValue([
      {
        name: BULK_REPO,
        path: repoPath,
        storagePath: path.join(tmpDir, 'storage'),
        indexedAt: INDEXED_AT,
        lastCommit: indexedCommit,
        stats: { files: 1002, nodes: 1002, communities: 0, processes: 0 },
      },
    ]);
    repoManagerMocks.loadMeta.mockResolvedValue({
      branch: BRANCH,
      indexedAt: INDEXED_AT,
      lastCommit: indexedCommit,
    });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marks the result truncated and keeps the first 1000 entries', async () => {
    const backend = new LocalBackend();

    const out = await backend.callTool('repo_changes', {
      repo: BULK_REPO,
      branch: BRANCH,
      since: baseCommit,
    });

    expect(out.state).toBe('ok');
    expect(out.truncated).toBe(true);
    expect(out.files).toHaveLength(1000);
  });
});
