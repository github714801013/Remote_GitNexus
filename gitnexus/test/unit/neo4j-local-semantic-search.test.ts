import { describe, expect, it, vi, afterEach } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { executeQuery } from '../../src/core/lbug/pool-adapter.js';
import { semanticSearch as neo4jSemanticSearch } from '../../src/core/neo4j/embedding-adapter.js';
import { embedQuery } from '../../src/mcp/core/embedder.js';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn(),
  executeQuery: vi.fn(),
  executeParameterized: vi.fn(),
  closeLbug: vi.fn(),
  isLbugReady: vi.fn(() => true),
  isWriteQuery: vi.fn(() => false),
}));

vi.mock('../../src/core/neo4j/config.js', () => ({
  isNeo4jBackendEnabled: vi.fn(() => true),
}));

vi.mock('../../src/core/neo4j/embedding-adapter.js', () => ({
  semanticSearch: vi.fn(async () => [
    {
      nodeId: 'Function:a',
      name: 'handler',
      type: 'Function',
      filePath: 'src/a.ts',
      startLine: 1,
      endLine: 5,
      distance: 0.1,
    },
  ]),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn(async () => [0.1, 0.2]),
  getEmbeddingDims: vi.fn(() => 2),
}));

describe('LocalBackend semanticSearch with Neo4j backend', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses Neo4j vector search instead of LadybugDB vector index', async () => {
    const backend = new LocalBackend();

    const results = await (backend as any).semanticSearch(
      {
        id: 'repo-a',
        name: 'Repo A',
        repoPath: '/repo/a',
        storagePath: '/repo/a/.gitnexus',
        lbugPath: '/repo/a/.gitnexus/lbug',
        indexedAt: '2026-05-30',
        lastCommit: 'abc',
      },
      'find handler',
      3,
    );

    expect(embedQuery).toHaveBeenCalledWith('find handler');
    expect(neo4jSemanticSearch).toHaveBeenCalledWith('Repo A', [0.1, 0.2], 3);
    expect(executeQuery).not.toHaveBeenCalled();
    expect(results).toEqual([
      expect.objectContaining({
        nodeId: 'Function:a',
        filePath: 'src/a.ts',
      }),
    ]);
  });
});
