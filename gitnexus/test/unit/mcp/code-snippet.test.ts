import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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

describe('LocalBackend code_snippet tool', () => {
  let tmpDir: string;
  let repoPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-snippet-'));
    repoPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, 'src', 'sample.ts'),
      ['line 1', 'line 2', 'line 3', 'line 4'].join('\n'),
      'utf-8',
    );

    repoManagerMocks.listRegisteredRepos.mockResolvedValue([
      {
        name: 'sample',
        path: repoPath,
        storagePath: path.join(tmpDir, 'storage'),
        indexedAt: '2026-05-12T00:00:00.000Z',
        lastCommit: 'abc123',
        stats: { files: 1, nodes: 1, communities: 0, processes: 0 },
      },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads a bounded line range directly from the repository file', async () => {
    const backend = new LocalBackend();

    const out = await backend.callTool('code_snippet', {
      repo: 'sample',
      filePath: 'src/sample.ts',
      startLine: 2,
      endLine: 3,
    });

    expect(out).toEqual(
      expect.objectContaining({
        repo: 'sample',
        filePath: 'src/sample.ts',
        startLine: 2,
        endLine: 3,
        actualStartLine: 2,
        actualEndLine: 3,
        commit: 'abc123',
        content: 'line 2\nline 3',
      }),
    );
  });

  it('rejects paths outside the repository root', async () => {
    const backend = new LocalBackend();

    await expect(
      backend.callTool('code_snippet', {
        repo: 'sample',
        filePath: '../secret.txt',
        startLine: 1,
        endLine: 1,
      }),
    ).rejects.toThrow(/outside repository/i);
  });

  it('rejects oversized line ranges', async () => {
    const backend = new LocalBackend();

    await expect(
      backend.callTool('code_snippet', {
        repo: 'sample',
        filePath: 'src/sample.ts',
        startLine: 1,
        endLine: 1000,
      }),
    ).rejects.toThrow(/line range/i);
  });
});
