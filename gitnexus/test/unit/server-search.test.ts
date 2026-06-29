import { describe, expect, it, vi, beforeEach } from 'vitest';
import neo4j from 'neo4j-driver';

const embedQuery = vi.fn();
const neo4jSemanticSearch = vi.fn();
const countEmbeddings = vi.fn();
const deleteEmbeddingsForNodes = vi.fn();
const ensureNeo4jEmbeddingIndex = vi.fn();
const fetchExistingEmbeddingHashes = vi.fn();
const loadEmbeddableNodes = vi.fn();
const upsertEmbeddings = vi.fn();
const executeReadCypher = vi.fn();
const executeRepoScopedReadCypher = vi.fn();
const runEmbeddingPipeline = vi.fn();
const withEmbeddingBaseUrl = vi.fn(async (_url: string | undefined, fn: () => Promise<void>) =>
  fn(),
);
const readServerMapping = vi.fn();

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery,
}));

vi.mock('../../src/core/neo4j/embedding-adapter.js', () => ({
  semanticSearch: neo4jSemanticSearch,
  countEmbeddings,
  deleteEmbeddingsForNodes,
  ensureNeo4jEmbeddingIndex,
  fetchExistingEmbeddingHashes,
  loadEmbeddableNodes,
  upsertEmbeddings,
}));

vi.mock('../../src/core/neo4j/read-adapter.js', () => ({
  executeReadCypher,
  executeRepoScopedReadCypher,
}));

vi.mock('../../src/core/embeddings/embedding-pipeline.js', () => ({
  runEmbeddingPipeline,
}));

vi.mock('../../src/core/embeddings/http-client.js', () => ({
  withEmbeddingBaseUrl,
}));

vi.mock('../../src/core/embeddings/server-mapping.js', () => ({
  readServerMapping,
}));

describe('server search helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses Neo4j semantic search for HTTP hybrid search when Neo4j backend is enabled', async () => {
    embedQuery.mockResolvedValue([0.1, 0.2, 0.3]);
    neo4jSemanticSearch.mockResolvedValue([
      {
        repoId: 'saasoanew',
        nodeId: 'Method:Report.Get',
        name: 'Get',
        type: 'Method',
        filePath: 'Reports/Member.cs',
        startLine: 12,
        endLine: 18,
        score: 0.82,
        distance: 0.18,
      },
    ]);

    const { searchNeo4jBackend } = await import('../../src/server/search.js');
    const results = await searchNeo4jBackend({
      repoName: 'saasoanew',
      query: '会员购物统计',
      mode: 'hybrid',
      limit: 5,
    });

    expect(embedQuery).toHaveBeenCalledWith('会员购物统计');
    expect(neo4jSemanticSearch).toHaveBeenCalledWith('saasoanew', [0.1, 0.2, 0.3], 5);
    expect(results).toEqual([
      {
        repoId: 'saasoanew',
        nodeId: 'Method:Report.Get',
        name: 'Get',
        type: 'Method',
        label: 'Method',
        filePath: 'Reports/Member.cs',
        startLine: 12,
        endLine: 18,
        score: 0.82,
        distance: 0.18,
        rank: 1,
        sources: ['semantic'],
      },
    ]);
  });

  it('keeps BM25 empty for Neo4j HTTP search because no Neo4j FTS path exists yet', async () => {
    const { searchNeo4jBackend } = await import('../../src/server/search.js');
    const results = await searchNeo4jBackend({
      repoName: 'saasoanew',
      query: '会员购物统计',
      mode: 'bm25',
      limit: 5,
    });

    expect(results).toEqual([]);
    expect(embedQuery).not.toHaveBeenCalled();
    expect(neo4jSemanticSearch).not.toHaveBeenCalled();
  });

  it('rejects HTTP Cypher queries with repo scope but no explicit repoId filter', async () => {
    executeRepoScopedReadCypher.mockRejectedValueOnce(new Error('repoId is required'));
    const { queryNeo4jBackend } = await import('../../src/server/search.js');

    await expect(queryNeo4jBackend('MATCH (n) RETURN count(n) AS c', 'saasoanew')).rejects.toThrow(
      'repoId',
    );

    expect(executeRepoScopedReadCypher).toHaveBeenCalledWith(
      'MATCH (n) RETURN count(n) AS c',
      'saasoanew',
    );
  });

  it('runs HTTP Cypher queries through Neo4j read adapter with repoId params', async () => {
    executeRepoScopedReadCypher.mockResolvedValue([{ c: 231208 }]);

    const { queryNeo4jBackend } = await import('../../src/server/search.js');
    const result = await queryNeo4jBackend(
      'MATCH (n {repoId: $repoId}) RETURN count(n) AS c',
      'saasoanew',
    );

    expect(executeRepoScopedReadCypher).toHaveBeenCalledWith(
      'MATCH (n {repoId: $repoId}) RETURN count(n) AS c',
      'saasoanew',
    );
    expect(result).toEqual([{ c: 231208 }]);
  });

  it('keeps global HTTP Cypher queries available when repo scope is omitted', async () => {
    executeRepoScopedReadCypher.mockResolvedValue([{ c: 231208 }]);

    const { queryNeo4jBackend } = await import('../../src/server/search.js');
    const result = await queryNeo4jBackend('MATCH (n) RETURN count(n) AS c');

    expect(executeRepoScopedReadCypher).toHaveBeenCalledWith(
      'MATCH (n) RETURN count(n) AS c',
      undefined,
    );
    expect(result).toEqual([{ c: 231208 }]);
  });

  it('lists Neo4j processes scoped by repo', async () => {
    executeReadCypher.mockResolvedValue([
      {
        id: 'proc-1',
        label: '会员购物统计',
        heuristicLabel: '会员购物统计',
        processType: 'intra',
        stepCount: 4,
      },
    ]);

    const { queryNeo4jProcesses } = await import('../../src/server/search.js');
    const result = await queryNeo4jProcesses('saasoanew', 50);

    expect(executeReadCypher).toHaveBeenCalledWith(expect.stringContaining('MATCH (p:Process'), {
      repoId: 'saasoanew',
      limit: neo4j.int(50),
    });
    expect(result).toEqual({
      processes: [
        {
          id: 'proc-1',
          label: '会员购物统计',
          heuristicLabel: '会员购物统计',
          processType: 'intra',
          stepCount: 4,
        },
      ],
    });
  });

  it('lists Neo4j clusters scoped by repo', async () => {
    executeReadCypher.mockResolvedValue([
      {
        id: 'cluster-1',
        label: '统计模块',
        heuristicLabel: '统计模块',
        cohesion: 0.8,
        symbolCount: 12,
      },
    ]);

    const { queryNeo4jClusters } = await import('../../src/server/search.js');
    const result = await queryNeo4jClusters('saasoanew', 100);

    expect(executeReadCypher).toHaveBeenCalledWith(expect.stringContaining('MATCH (c:Community'), {
      repoId: 'saasoanew',
      limit: neo4j.int(100),
    });
    expect(result.clusters[0].label).toBe('统计模块');
  });

  it('loads Neo4j process detail scoped by repo', async () => {
    executeReadCypher
      .mockResolvedValueOnce([
        {
          id: 'proc-1',
          label: '会员购物统计',
          heuristicLabel: '会员购物统计',
          processType: 'intra',
          stepCount: 2,
        },
      ])
      .mockResolvedValueOnce([
        { name: 'LoadData', type: 'Method', filePath: 'Report.cs', step: 1 },
        { name: 'Export', type: 'Method', filePath: 'Report.cs', step: 2 },
      ]);

    const { queryNeo4jProcessDetail } = await import('../../src/server/search.js');
    const result = await queryNeo4jProcessDetail('会员购物统计', 'saasoanew');

    expect(executeReadCypher).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('MATCH (p:Process'),
      {
        repoId: 'saasoanew',
        name: '会员购物统计',
      },
    );
    expect(result.steps).toHaveLength(2);
  });

  it('loads Neo4j cluster detail scoped by repo', async () => {
    executeReadCypher
      .mockResolvedValueOnce([
        {
          id: 'cluster-1',
          label: '统计模块',
          heuristicLabel: '统计模块',
          cohesion: 0.9,
          symbolCount: 3,
        },
      ])
      .mockResolvedValueOnce([{ name: 'Report', type: 'Class', filePath: 'Report.cs' }]);

    const { queryNeo4jClusterDetail } = await import('../../src/server/search.js');
    const result = await queryNeo4jClusterDetail('统计模块', 'saasoanew');

    expect(executeReadCypher).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('MATCH (c:Community'),
      {
        repoId: 'saasoanew',
        name: '统计模块',
      },
    );
    expect(result.members).toEqual([{ name: 'Report', type: 'Class', filePath: 'Report.cs' }]);
  });

  it('lists Neo4j file paths for HTTP grep', async () => {
    executeReadCypher.mockResolvedValue([
      { filePath: 'Report.cs' },
      { filePath: 'Views/Index.aspx' },
    ]);

    const { listNeo4jFilePaths } = await import('../../src/server/search.js');
    const result = await listNeo4jFilePaths('saasoanew');

    expect(executeReadCypher).toHaveBeenCalledWith(expect.stringContaining('MATCH (f:File'), {
      repoId: 'saasoanew',
    });
    expect(result).toEqual(['Report.cs', 'Views/Index.aspx']);
  });

  it('builds HTTP graph from Neo4j rows', async () => {
    executeReadCypher.mockImplementation(async (query: string) => {
      if (query.includes('MATCH (a {repoId: $repoId})-[r]->')) {
        return [
          {
            sourceId: 'File:Report.cs',
            targetId: 'Method:Report.Get',
            type: 'DEFINES',
            confidence: 1,
            reason: 'test',
            step: null,
          },
        ];
      }
      if (query.includes('MATCH (n:`File`')) {
        return [{ id: 'File:Report.cs', name: 'Report.cs', filePath: 'Report.cs' }];
      }
      return [];
    });

    const { buildNeo4jGraph } = await import('../../src/server/search.js');
    const result = await buildNeo4jGraph('saasoanew', false);

    expect(result.nodes).toEqual([
      {
        id: 'File:Report.cs',
        label: 'File',
        properties: {
          name: 'Report.cs',
          filePath: 'Report.cs',
          startLine: undefined,
          endLine: undefined,
          content: undefined,
          responseKeys: undefined,
          errorKeys: undefined,
          middleware: undefined,
          heuristicLabel: undefined,
          cohesion: undefined,
          symbolCount: undefined,
          description: undefined,
          processType: undefined,
          stepCount: undefined,
          communities: undefined,
          entryPointId: undefined,
          terminalId: undefined,
        },
      },
    ]);
    expect(result.relationships[0].type).toBe('DEFINES');
  });

  it('runs Neo4j embedding repair for HTTP embed jobs', async () => {
    readServerMapping.mockResolvedValue('server-a');
    fetchExistingEmbeddingHashes.mockResolvedValue(new Map());
    countEmbeddings.mockResolvedValue(218506);

    const { runNeo4jEmbeddingRepair } = await import('../../src/server/search.js');
    const count = await runNeo4jEmbeddingRepair('saasoanew', vi.fn());

    expect(readServerMapping).toHaveBeenCalledWith('saasoanew');
    expect(withEmbeddingBaseUrl).toHaveBeenCalled();
    expect(runEmbeddingPipeline).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      {},
      undefined,
      { repoName: 'saasoanew', serverName: 'server-a' },
      expect.any(Map),
      {
        loadNodes: expect.any(Function),
        insertEmbeddings: expect.any(Function),
        deleteEmbeddingsForNodeIds: expect.any(Function),
        ensureVectorIndex: ensureNeo4jEmbeddingIndex,
      },
    );
    expect(count).toBe(218506);
  });
});
