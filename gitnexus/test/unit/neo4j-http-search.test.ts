import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchNeo4jBackend } from '../../src/server/search.js';
import { semanticSearch } from '../../src/core/neo4j/embedding-adapter.js';
import { embedQuery } from '../../src/mcp/core/embedder.js';
import { executeReadCypher } from '../../src/core/neo4j/read-adapter.js';

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn(),
}));

vi.mock('../../src/core/neo4j/embedding-adapter.js', () => ({
  semanticSearch: vi.fn(),
}));

vi.mock('../../src/core/neo4j/read-adapter.js', () => ({
  executeReadCypher: vi.fn(),
}));

const mockFulltextHit = () => {
  vi.mocked(executeReadCypher).mockImplementation(async (cypher: string) => {
    if (cypher.includes("'function_fts'")) {
      return [
        {
          nodeId: 'Function:src/a.ts:handlerA',
          name: 'handlerA',
          type: 'Function',
          filePath: 'src/a.ts',
          startLine: 1,
          endLine: 5,
          score: 9,
        },
      ];
    }
    return [];
  });
};

describe('Neo4j HTTP search fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(embedQuery).mockResolvedValue([0.1, 0.2]);
    vi.mocked(semanticSearch).mockResolvedValue([
      {
        repoId: 'Repo A',
        nodeId: 'Function:src/semantic.ts:handlerA',
        name: 'handlerA',
        type: 'Function',
        filePath: 'src/semantic.ts',
        startLine: 10,
        endLine: 20,
        distance: 0.2,
      },
    ] as any);
    vi.mocked(executeReadCypher).mockResolvedValue([]);
  });

  it('keeps the existing semantic path when embeddings are healthy', async () => {
    const results = await searchNeo4jBackend({
      repoName: 'Repo A',
      query: 'handler',
      mode: 'hybrid',
      limit: 5,
    });

    expect(embedQuery).toHaveBeenCalledWith('handler');
    expect(semanticSearch).toHaveBeenCalledWith('Repo A', [0.1, 0.2], 5);
    expect(executeReadCypher).not.toHaveBeenCalled();
    expect(results).toEqual([
      expect.objectContaining({
        filePath: 'src/semantic.ts',
        sources: ['semantic'],
        score: 0.8,
        rank: 1,
      }),
    ]);
  });

  it('uses Neo4j fulltext search for bm25 mode without calling embeddings', async () => {
    mockFulltextHit();

    const results = await searchNeo4jBackend({
      repoName: 'Repo A',
      query: 'handler',
      mode: 'bm25',
      limit: 5,
    });

    expect(embedQuery).not.toHaveBeenCalled();
    expect(semanticSearch).not.toHaveBeenCalled();
    expect(executeReadCypher).toHaveBeenCalledWith(expect.stringContaining("'function_fts'"), {
      repoId: 'Repo A',
      query: 'handler',
      limit: 5,
    });
    expect(results).toEqual([
      expect.objectContaining({
        nodeId: 'Function:src/a.ts:handlerA',
        filePath: 'src/a.ts',
        label: 'Function',
        sources: ['bm25'],
        score: 9,
        rank: 1,
      }),
    ]);
  });

  it('falls back to Neo4j fulltext search when embedding query generation fails', async () => {
    vi.mocked(embedQuery).mockRejectedValueOnce(new Error('embedding service unavailable'));
    mockFulltextHit();

    const results = await searchNeo4jBackend({
      repoName: 'Repo A',
      query: 'handler',
      mode: 'hybrid',
      limit: 5,
    });

    expect(semanticSearch).not.toHaveBeenCalled();
    expect(executeReadCypher).toHaveBeenCalled();
    expect(results).toEqual([
      expect.objectContaining({
        filePath: 'src/a.ts',
        sources: ['bm25'],
        score: 9,
        rank: 1,
      }),
    ]);
  });
});
