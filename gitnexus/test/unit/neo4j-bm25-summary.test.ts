import { describe, expect, it, vi, beforeEach } from 'vitest';

const executeReadCypherMock = vi.fn();

vi.mock('@ladybugdb/core', () => ({
  default: {},
}));

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn(),
  executeQuery: vi.fn(),
  executeParameterized: vi.fn(),
  closeLbug: vi.fn(),
  isLbugReady: vi.fn().mockReturnValue(true),
  silenceStdout: vi.fn(),
  restoreStdout: vi.fn(),
  realStderrWrite: vi.fn(),
}));

vi.mock('../../src/core/neo4j/config.js', () => ({
  isNeo4jBackendEnabled: () => true,
}));

vi.mock('../../src/core/neo4j/read-adapter.js', () => ({
  executeReadCypher: (...args: any[]) => executeReadCypherMock(...args),
}));

vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn(async () => {
    throw new Error('Neo4j BM25 test unexpectedly used LadybugDB FTS');
  }),
}));

describe('Neo4j BM25 keyword search', () => {
  beforeEach(() => {
    executeReadCypherMock.mockReset();
  });

  it('matches generated keyword summaries stored in symbol descriptions', async () => {
    executeReadCypherMock.mockImplementation(async (cypher: string) => {
      if (cypher.includes("'function_fts'")) {
        return [
          {
            id: 'Function:src/order.ts:summarizeApproval',
            name: 'summarizeApproval',
            type: 'Function',
            filePath: 'src/order.ts',
            startLine: 10,
            endLine: 20,
            score: 7.5,
          },
        ];
      }
      return [];
    });
    const { LocalBackend } = await import('../../src/mcp/local/local-backend.js');
    const backend = new LocalBackend();
    const repo = {
      id: 'repo1',
      name: 'repo1',
      repoPath: 'D:\\repo',
      storagePath: 'D:\\repo\\.gitnexus',
      lbugPath: 'D:\\repo\\.gitnexus\\lbug',
      indexedAt: 'now',
      lastCommit: 'c',
      stats: {},
    } as any;

    const result = await (backend as any).bm25Search(repo, '订单审批摘要', 5);

    expect(result.ftsUsed).toBe(true);
    expect(result.results).toEqual([
      expect.objectContaining({
        nodeId: 'Function:src/order.ts:summarizeApproval',
        name: 'summarizeApproval',
        type: 'Function',
        filePath: 'src/order.ts',
        bm25Score: 7.5,
      }),
    ]);
    expect(executeReadCypherMock.mock.calls.some(([cypher]) => cypher.includes("'file_fts'"))).toBe(
      true,
    );
    expect(
      executeReadCypherMock.mock.calls.some(([cypher]) => cypher.includes("'function_fts'")),
    ).toBe(true);
  });
});
