import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

vi.mock('../../../src/storage/repo-manager.js', () => repoManagerMocks);

vi.mock('../../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/lbug/pool-adapter.js')>();
  return {
    ...actual,
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});

import { LocalBackend } from '../../../src/mcp/local/local-backend.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function commit(
  repoPath: string,
  authorName: string,
  authorEmail: string,
  message: string,
): string {
  execFileSync('git', ['add', 'src/sample.ts'], { cwd: repoPath, stdio: 'ignore' });
  return git(
    [
      '-c',
      `user.name=${authorName}`,
      '-c',
      `user.email=${authorEmail}`,
      'commit',
      '--author',
      `${authorName} <${authorEmail}>`,
      '-m',
      message,
    ],
    repoPath,
  );
}

describe('LocalBackend git_author_trace tool', () => {
  let tmpDir: string;
  let repoPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-author-trace-'));
    repoPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    git(['init'], repoPath);

    fs.writeFileSync(path.join(repoPath, 'src', 'sample.ts'), 'line 1\n', 'utf-8');
    commit(repoPath, 'Alice Dev', 'alice@example.com', 'initial sample');

    fs.writeFileSync(path.join(repoPath, 'src', 'sample.ts'), 'line 1\nline 2\n', 'utf-8');
    commit(repoPath, 'Bob Dev', 'bob@example.com', 'add second line');

    repoManagerMocks.listRegisteredRepos.mockResolvedValue([
      {
        name: 'sample',
        path: repoPath,
        storagePath: path.join(tmpDir, 'storage'),
        indexedAt: '2026-06-14T00:00:00.000Z',
        lastCommit: git(['rev-parse', 'HEAD'], repoPath),
        stats: { files: 1, nodes: 1, communities: 0, processes: 0 },
      },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns current blame authors and bounded commit history for a line range', async () => {
    const backend = new LocalBackend();

    const out = await backend.callTool('git_author_trace', {
      repo: 'sample',
      filePath: 'src/sample.ts',
      startLine: 1,
      endLine: 2,
      maxCommits: 5,
    });

    expect(out).toEqual(
      expect.objectContaining({
        repo: 'sample',
        filePath: 'src/sample.ts',
        startLine: 1,
        endLine: 2,
        truncatedHistory: false,
      }),
    );
    expect(out.primaryAuthors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Alice Dev',
          email: 'alice@example.com',
          lines: [1],
          lastSummary: 'initial sample',
        }),
        expect.objectContaining({
          name: 'Bob Dev',
          email: 'bob@example.com',
          lines: [2],
          lastSummary: 'add second line',
        }),
      ]),
    );
    expect(out.commits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authorName: 'Bob Dev',
          authorEmail: 'bob@example.com',
          summary: 'add second line',
        }),
        expect.objectContaining({
          authorName: 'Alice Dev',
          authorEmail: 'alice@example.com',
          summary: 'initial sample',
        }),
      ]),
    );
  });

  it('omits history when includeHistory is false', async () => {
    const backend = new LocalBackend();

    const out = await backend.callTool('git_author_trace', {
      repo: 'sample',
      filePath: 'src/sample.ts',
      startLine: 1,
      endLine: 2,
      includeHistory: false,
    });

    expect(out.commits).toEqual([]);
    expect(out.truncatedHistory).toBe(false);
  });

  it('rejects paths outside the repository root', async () => {
    const backend = new LocalBackend();

    await expect(
      backend.callTool('git_author_trace', {
        repo: 'sample',
        filePath: '../secret.ts',
        startLine: 1,
        endLine: 1,
      }),
    ).rejects.toThrow(/outside repository/i);
  });
});
