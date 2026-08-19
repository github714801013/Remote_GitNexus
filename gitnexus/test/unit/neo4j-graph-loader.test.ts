import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

const txRun = vi.fn();
const executeWrite = vi.fn(async (work: any) => work({ run: txRun }));
const withNeo4jSession = vi.fn(async (work: any) => work({ executeWrite }));
const clearRepoIndex = vi.fn();
const upsertNodes = vi.fn();
const upsertRelations = vi.fn();

vi.mock('../../src/core/neo4j/driver.js', () => ({
  withNeo4jSession,
}));

vi.mock('../../src/core/neo4j/schema.js', () => ({
  getNeo4jSchemaStatements: vi.fn(() => ({
    all: ['CREATE CONSTRAINT one', 'CREATE INDEX two'],
  })),
}));

vi.mock('../../src/core/neo4j/write-adapter.js', () => ({
  clearRepoIndex,
  upsertNodes,
  upsertRelations,
}));

describe('Neo4j graph loader', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('applies schema, clears repo data, and writes graph nodes and relationships', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'File:src/a.ts',
      label: 'File',
      properties: { name: 'a.ts', filePath: 'src/a.ts' },
    });
    graph.addNode({
      id: 'Function:a',
      label: 'Function',
      properties: { name: 'a', filePath: 'src/a.ts', startLine: 1, endLine: 3 },
    });
    graph.addRelationship({
      id: 'rel:a',
      sourceId: 'File:src/a.ts',
      targetId: 'Function:a',
      type: 'CONTAINS',
      confidence: 1,
      reason: 'test',
    });

    const { loadGraphToNeo4j } = await import('../../src/core/neo4j/graph-loader.js');
    const stats = await loadGraphToNeo4j('repo-a', graph);

    expect(txRun).toHaveBeenCalledWith('CREATE CONSTRAINT one');
    expect(txRun).toHaveBeenCalledWith('CREATE INDEX two');
    expect(clearRepoIndex).toHaveBeenCalledWith(
      'repo-a',
      expect.objectContaining({ preserveEmbeddings: undefined }),
    );
    expect(upsertNodes).toHaveBeenCalledWith(
      'repo-a',
      [
      {
        label: 'File',
        properties: { id: 'File:src/a.ts', name: 'a.ts', filePath: 'src/a.ts' },
      },
      {
        label: 'Function',
        properties: {
          id: 'Function:a',
          name: 'a',
          filePath: 'src/a.ts',
          startLine: 1,
          endLine: 3,
        },
      },
    ],
    undefined,
  );
    expect(upsertRelations).toHaveBeenCalledWith(
      'repo-a',
      [
        {
          type: 'CONTAINS',
          fromId: 'File:src/a.ts',
          toId: 'Function:a',
          properties: { type: 'CONTAINS', confidence: 1, reason: 'test', step: undefined },
        },
      ],
      undefined,
    );
    expect(stats).toEqual({ nodes: 2, edges: 1 });
  });

  it('reports schema and embedding relink boundaries to the loader callback', async () => {
    const graph = createKnowledgeGraph();
    const onProgress = vi.fn();
    const { loadGraphToNeo4j } = await import('../../src/core/neo4j/graph-loader.js');

    await loadGraphToNeo4j('repo-a', graph, { preserveEmbeddings: true, onProgress });

    expect(onProgress).toHaveBeenNthCalledWith(1, { operation: 'schema' });
    expect(onProgress).toHaveBeenLastCalledWith({ operation: 'relinkEmbeddings' });
    expect(clearRepoIndex).toHaveBeenCalledWith(
      'repo-a',
      expect.objectContaining({ preserveEmbeddings: true, onProgress }),
    );
  });

  it('normalizes nested node properties to Neo4j-safe types before writing', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Class:OrderService',
      label: 'Class',
      properties: {
        name: 'OrderService',
        filePath: 'src/OrderService.java',
        keywords: ['order', 'service'],
        springDiProvider: { names: ['largePurchasesFallback'], preferenceReason: 'test' },
        springDiInjectionSites: [{ targetTypeName: 'OrderRepo', cardinality: 1, reason: 'field' }],
        nullableField: null,
      },
    });

    const { loadGraphToNeo4j } = await import('../../src/core/neo4j/graph-loader.js');
    await loadGraphToNeo4j('repo-a', graph);

    const written = upsertNodes.mock.calls[0][1] as Array<{ properties: Record<string, unknown> }>;
    const props = written[0].properties;
    expect(props.name).toBe('OrderService');
    expect(props.keywords).toEqual(['order', 'service']);
    expect(props.springDiProvider).toBe(
      JSON.stringify({ names: ['largePurchasesFallback'], preferenceReason: 'test' }),
    );
    expect(props.springDiInjectionSites).toBe(
      JSON.stringify([{ targetTypeName: 'OrderRepo', cardinality: 1, reason: 'field' }]),
    );
    expect(props).not.toHaveProperty('nullableField');
  });

  it('preserves and re-links existing embeddings during a graph rebuild', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:a',
      label: 'Function',
      properties: { name: 'a', filePath: 'src/a.ts' },
    });

    const { loadGraphToNeo4j } = await import('../../src/core/neo4j/graph-loader.js');
    await loadGraphToNeo4j('repo-a', graph, { preserveEmbeddings: true });

    expect(clearRepoIndex).toHaveBeenCalledWith('repo-a', { preserveEmbeddings: true });
    expect(txRun).toHaveBeenCalledWith(
      'MATCH (e:CodeEmbedding {repoId: $repoId}) WHERE NOT (e)-[:EMBEDS]->() WITH e LIMIT $batchSize OPTIONAL MATCH (n:CodeNode {repoId: $repoId, id: e.nodeId}) FOREACH (_ IN CASE WHEN n IS NOT NULL THEN [1] ELSE [] END | MERGE (e)-[:EMBEDS]->(n)) FOREACH (_ IN CASE WHEN n IS NULL THEN [1] ELSE [] END | DETACH DELETE e) RETURN count(e) AS count',
      expect.objectContaining({ repoId: 'repo-a' }),
    );
  });

  it('re-links preserved embeddings in bounded batches until the loop is exhausted', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:a',
      label: 'Function',
      properties: { name: 'a', filePath: 'src/a.ts' },
    });

    const intCount = (n: number) => ({ toNumber: () => n });
    // 调用序列:2 条 schema 语句(无返回值)→ 合并循环 500→500→0(多轮收敛)
    txRun
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ records: [{ get: () => intCount(500) }] })
      .mockResolvedValueOnce({ records: [{ get: () => intCount(500) }] })
      .mockResolvedValueOnce({ records: [{ get: () => intCount(0) }] });

    const { loadGraphToNeo4j } = await import('../../src/core/neo4j/graph-loader.js');
    await loadGraphToNeo4j('repo-a', graph, { preserveEmbeddings: true });

    const relinkCalls = txRun.mock.calls.filter(([query]) =>
      String(query).includes('OPTIONAL MATCH (n:CodeNode'),
    );
    expect(relinkCalls).toHaveLength(3);
    for (const [, params] of relinkCalls) {
      expect((params as { batchSize: { toNumber: () => number } }).batchSize.toNumber()).toBe(500);
    }
  });

  it('exits the relink loop immediately when the first batch is already empty', async () => {
    const graph = createKnowledgeGraph();
    const intCount = (n: number) => ({ toNumber: () => n });
    // 第一轮 count=0(全部 embedding 已连边或无待处理项)→ 循环直接退出
    txRun
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ records: [{ get: () => intCount(0) }] });

    const { loadGraphToNeo4j } = await import('../../src/core/neo4j/graph-loader.js');
    await loadGraphToNeo4j('repo-a', graph, { preserveEmbeddings: true });

    const relinkCalls = txRun.mock.calls.filter(([query]) =>
      String(query).includes('OPTIONAL MATCH (n:CodeNode'),
    );
    expect(relinkCalls).toHaveLength(1);
  });
});
