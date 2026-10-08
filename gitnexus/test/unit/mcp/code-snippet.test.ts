import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const { repoManagerMocks, neo4jMocks } = vi.hoisted(() => ({
  repoManagerMocks: {
    listRegisteredRepos: vi.fn(),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    loadMeta: vi.fn().mockResolvedValue(undefined),
  },
  neo4jMocks: {
    isNeo4jBackendEnabled: vi.fn().mockReturnValue(false),
    executeReadCypher: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@ladybugdb/core', () => ({
  default: {},
}));

vi.mock('../../../src/storage/repo-manager.js', () => repoManagerMocks);

vi.mock('../../../src/core/neo4j/config.js', () => ({
  isNeo4jBackendEnabled: neo4jMocks.isNeo4jBackendEnabled,
}));

vi.mock('../../../src/core/neo4j/read-adapter.js', () => ({
  executeReadCypher: neo4jMocks.executeReadCypher,
}));

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

  afterEach(async () => {
    const { executeParameterized } = await import('../../../src/core/lbug/pool-adapter.js');
    (executeParameterized as unknown as ReturnType<typeof vi.fn>).mockReset();
    (executeParameterized as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    neo4jMocks.executeReadCypher.mockReset();
    neo4jMocks.executeReadCypher.mockResolvedValue([]);
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

  it('explains a missing file that the index still lists (stale index)', async () => {
    const { executeParameterized } = await import('../../../src/core/lbug/pool-adapter.js');
    (executeParameterized as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { found: 1 },
    ]);
    const backend = new LocalBackend();

    await expect(
      backend.callTool('code_snippet', {
        repo: 'sample',
        filePath: 'src/moved-away.ts',
        startLine: 1,
        endLine: 1,
      }),
    ).rejects.toThrow(/index may be stale/i);
  });

  it('never leaks a raw ENOENT when the path is not part of the repository', async () => {
    const backend = new LocalBackend();

    const error = await backend
      .callTool('code_snippet', {
        repo: 'sample',
        filePath: 'src/only-in-another-repo.ts',
        startLine: 1,
        endLine: 1,
      })
      .catch((err: unknown) => err as Error);

    expect(error.message).not.toMatch(/ENOENT/);
    expect(error.message).toMatch(/not present on disk in repository "sample"/i);
    expect(error.message).toMatch(/not listed in its index/i);
    expect(error.message).toMatch(/context\/query results/i);
  });

  it('never leaks a raw ENOENT when the index lookup itself fails', async () => {
    const { executeParameterized } = await import('../../../src/core/lbug/pool-adapter.js');
    (executeParameterized as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('LadybugDB not initialized'),
    );
    const backend = new LocalBackend();

    const error = await backend
      .callTool('code_snippet', {
        repo: 'sample',
        filePath: 'src/gone.ts',
        startLine: 1,
        endLine: 1,
      })
      .catch((err: unknown) => err as Error);

    expect(error.message).not.toMatch(/ENOENT/);
    expect(error.message).toMatch(/context\/query results/i);
  });

  describe('Neo4j backend', () => {
    beforeEach(() => {
      neo4jMocks.isNeo4jBackendEnabled.mockReturnValue(true);
    });

    afterEach(() => {
      neo4jMocks.isNeo4jBackendEnabled.mockReturnValue(false);
    });

    it('points at the repositories that really index the path', async () => {
      neo4jMocks.executeReadCypher.mockResolvedValueOnce([
        { repoId: 'oanew' },
        { repoId: 'dev-oanew' },
      ]);
      const backend = new LocalBackend();

      const error = await backend
        .callTool('code_snippet', {
          repo: 'sample',
          filePath: 'printerServices/Task/Impl/AreaTransfer.cs',
          startLine: 1,
          endLine: 1,
        })
        .catch((err: unknown) => err as Error);

      expect(error.message).toMatch(/indexed in: oanew, dev-oanew/i);
      expect(error.message).toMatch(/check the "repo" argument/i);
    });

    it('reports a stale index when this repository still lists the file', async () => {
      neo4jMocks.executeReadCypher.mockResolvedValueOnce([{ repoId: 'sample' }]);
      const backend = new LocalBackend();

      await expect(
        backend.callTool('code_snippet', {
          repo: 'sample',
          filePath: 'src/moved-away.ts',
          startLine: 1,
          endLine: 1,
        }),
      ).rejects.toThrow(/index may be stale/i);
    });
  });
});
