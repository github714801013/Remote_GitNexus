import { afterEach, describe, expect, it, vi } from 'vitest';

const countResult = (deleted: number) => ({
  records: [
    {
      get: () => deleted,
    },
  ],
});
const txRun = vi.fn(async () => countResult(0));
const executeWrite = vi.fn(async (work: any) => work({ run: txRun }));
const withNeo4jSession = vi.fn(async (work: any) => work({ executeWrite }));

vi.mock('../../src/core/neo4j/driver.js', () => ({
  withNeo4jSession,
}));

describe('Neo4j write adapter', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('clears all indexed data for one repoId in label-scoped batches', async () => {
    const { clearRepoIndex } = await import('../../src/core/neo4j/write-adapter.js');
    txRun
      .mockResolvedValueOnce(countResult(500))
      .mockResolvedValueOnce(countResult(1))
      .mockResolvedValueOnce(countResult(12));

    await clearRepoIndex('repo-a');

    expect(txRun).toHaveBeenNthCalledWith(
      1,
      'MATCH (n:`File` {repoId: $repoId}) WITH n LIMIT $batchSize DETACH DELETE n RETURN count(n) AS deleted',
      {
        repoId: 'repo-a',
        batchSize: expect.objectContaining({ low: 500, high: 0 }),
      },
    );
    expect(txRun).toHaveBeenNthCalledWith(
      2,
      'MATCH (n:`File` {repoId: $repoId}) WITH n LIMIT $batchSize DETACH DELETE n RETURN count(n) AS deleted',
      {
        repoId: 'repo-a',
        batchSize: expect.objectContaining({ low: 500, high: 0 }),
      },
    );
    expect(txRun).toHaveBeenCalledWith(
      'MATCH (n:`CodeNode` {repoId: $repoId}) WITH n LIMIT $batchSize DETACH DELETE n RETURN count(n) AS deleted',
      expect.objectContaining({ repoId: 'repo-a' }),
    );
    expect(txRun).toHaveBeenCalledWith(
      'MATCH (n:`CodeEmbedding` {repoId: $repoId}) WITH n LIMIT $batchSize DETACH DELETE n RETURN count(n) AS deleted',
      expect.objectContaining({ repoId: 'repo-a' }),
    );
  });

  it('batch upserts nodes grouped by label', async () => {
    const { upsertNodes } = await import('../../src/core/neo4j/write-adapter.js');

    await upsertNodes('repo-a', [
      { label: 'Function', properties: { id: 'Function:one', name: 'one', filePath: 'a.ts' } },
      { label: 'Function', properties: { id: 'Function:two', name: 'two', filePath: 'b.ts' } },
      { label: 'File', properties: { id: 'File:a.ts', name: 'a.ts', filePath: 'a.ts' } },
    ]);

    expect(txRun).toHaveBeenCalledWith(
      'UNWIND $nodes AS row MERGE (n:`CodeNode` {repoId: $repoId, id: row.id}) SET n:`Function` SET n += row.props',
      {
        repoId: 'repo-a',
        nodes: [
          {
            id: 'Function:one',
            props: { id: 'Function:one', repoId: 'repo-a', name: 'one', filePath: 'a.ts' },
          },
          {
            id: 'Function:two',
            props: { id: 'Function:two', repoId: 'repo-a', name: 'two', filePath: 'b.ts' },
          },
        ],
      },
    );
    expect(txRun).toHaveBeenCalledWith(
      'UNWIND $nodes AS row MERGE (n:`CodeNode` {repoId: $repoId, id: row.id}) SET n:`File` SET n += row.props',
      {
        repoId: 'repo-a',
        nodes: [
          {
            id: 'File:a.ts',
            props: { id: 'File:a.ts', repoId: 'repo-a', name: 'a.ts', filePath: 'a.ts' },
          },
        ],
      },
    );
  });

  it('splits node writes into bounded transactions', async () => {
    const { upsertNodes } = await import('../../src/core/neo4j/write-adapter.js');
    const nodes = Array.from({ length: 1201 }, (_, i) => ({
      label: 'Function',
      properties: { id: `Function:${i}`, name: `fn${i}`, filePath: 'a.ts' },
    }));

    await upsertNodes('repo-a', nodes);

    expect(executeWrite).toHaveBeenCalledTimes(3);
    const nodeBatchSizes = txRun.mock.calls.map(([, params]) => params.nodes.length);
    expect(nodeBatchSizes).toEqual([500, 500, 201]);
  });

  it('rejects unknown node labels', async () => {
    const { upsertNodes } = await import('../../src/core/neo4j/write-adapter.js');

    await expect(
      upsertNodes('repo-a', [{ label: 'Bad`Label', properties: { id: 'x' } }]),
    ).rejects.toThrow('Unsupported Neo4j node label: Bad`Label');
  });

  it('batch upserts relationships grouped by type', async () => {
    const { upsertRelations } = await import('../../src/core/neo4j/write-adapter.js');

    await upsertRelations('repo-a', [
      {
        type: 'CALLS',
        fromId: 'Function:caller',
        toId: 'Function:callee',
        properties: { confidence: 0.9, reason: 'test' },
      },
    ]);

    expect(txRun).toHaveBeenCalledWith(
      'UNWIND $relationships AS row MATCH (from:`CodeNode` {repoId: $repoId, id: row.fromId}) MATCH (to:`CodeNode` {repoId: $repoId, id: row.toId}) MERGE (from)-[r:`CALLS`]->(to) SET r += row.props',
      {
        repoId: 'repo-a',
        relationships: [
          {
            fromId: 'Function:caller',
            toId: 'Function:callee',
            props: { type: 'CALLS', confidence: 0.9, reason: 'test' },
          },
        ],
      },
    );
  });

  it('splits relationship writes into bounded transactions', async () => {
    const { upsertRelations } = await import('../../src/core/neo4j/write-adapter.js');
    const relationships = Array.from({ length: 1201 }, (_, i) => ({
      type: 'CALLS',
      fromId: `Function:caller-${i}`,
      toId: `Function:callee-${i}`,
      properties: { confidence: 1 },
    }));

    await upsertRelations('repo-a', relationships);

    expect(executeWrite).toHaveBeenCalledTimes(3);
    const relationshipBatchSizes = txRun.mock.calls.map(
      ([, params]) => params.relationships.length,
    );
    expect(relationshipBatchSizes).toEqual([500, 500, 201]);
  });

  it('rejects unknown relationship types', async () => {
    const { upsertRelations } = await import('../../src/core/neo4j/write-adapter.js');

    await expect(
      upsertRelations('repo-a', [
        { type: 'DROP', fromId: 'Function:a', toId: 'Function:b', properties: {} },
      ]),
    ).rejects.toThrow('Unsupported Neo4j relationship type: DROP');
  });
});
