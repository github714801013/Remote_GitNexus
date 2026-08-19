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
    txRun.mockImplementation(async () => countResult(0));
    executeWrite.mockImplementation(async (work: any) => work({ run: txRun }));
    withNeo4jSession.mockImplementation(async (work: any) => work({ executeWrite }));
  });

  it('clears all indexed data for one repoId in label-scoped batches', async () => {
    const { clearRepoIndex } = await import('../../src/core/neo4j/write-adapter.js');
    const onProgress = vi.fn();
    txRun
      .mockResolvedValueOnce(countResult(500))
      .mockResolvedValueOnce(countResult(1))
      .mockResolvedValueOnce(countResult(12));

    await clearRepoIndex('repo-a', { onProgress });

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
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'clear',
        completedBatches: 1,
        completedItems: 500,
        label: 'File',
      }),
    );
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'clear',
        completedBatches: 2,
        completedItems: 501,
        label: 'File',
      }),
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

  it('reports each successful node write batch with cumulative progress', async () => {
    const { upsertNodes } = await import('../../src/core/neo4j/write-adapter.js');
    const onProgress = vi.fn();
    const nodes = Array.from({ length: 1201 }, (_, i) => ({
      label: 'Function',
      properties: { id: `Function:${i}`, name: `fn${i}`, filePath: 'a.ts' },
    }));

    await upsertNodes('repo-a', nodes, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        operation: 'nodes',
        completedBatches: 1,
        totalBatches: 3,
        completedItems: 500,
        totalItems: 1201,
        label: 'Function',
      }),
      expect.objectContaining({ completedBatches: 2, completedItems: 1000 }),
      expect.objectContaining({ completedBatches: 3, completedItems: 1201 }),
    ]);
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

  it('passes a fixed ten-minute timeout to each relationship write', async () => {
    const { upsertRelations } = await import('../../src/core/neo4j/write-adapter.js');

    await upsertRelations('repo-a', [
      {
        type: 'CALLS',
        fromId: 'Function:caller',
        toId: 'Function:callee',
        properties: { confidence: 0.9 },
      },
    ]);

    expect(executeWrite).toHaveBeenCalledWith(expect.any(Function), { timeout: 600_000 });
  });

  it('logs safe relationship transaction boundaries', async () => {
    const { _captureLogger } = await import('../../src/core/logger.js');
    const capture = _captureLogger();
    const { upsertRelations } = await import('../../src/core/neo4j/write-adapter.js');

    try {
      await upsertRelations('repo-a', [
        {
          type: 'CALLS',
          fromId: 'Function:caller',
          toId: 'Function:callee',
          properties: { confidence: 0.9, reason: 'sensitive-reason' },
        },
      ]);

      const records = capture.records().filter((record) => record.operation === 'neo4j.relationships');
      expect(records.map((record) => record.msg)).toEqual([
        'Neo4j relationship batch started',
        'Neo4j relationship transaction attempt started',
        'Neo4j relationship tx.run returned',
        'Neo4j relationship batch committed',
      ]);
      expect(records[3]).toMatchObject({
        relationshipType: 'CALLS',
        batchIndex: 1,
        totalBatches: 1,
        batchSize: 1,
        totalRelationships: 1,
        completedRelationships: 1,
      });
      expect(records[2].txRunElapsedMs).toEqual(expect.any(Number));
      expect(records[3].batchElapsedMs).toEqual(expect.any(Number));
      expect(records[3].cumulativeElapsedMs).toEqual(expect.any(Number));
      expect(capture.text()).not.toContain('Function:caller');
      expect(capture.text()).not.toContain('Function:callee');
      expect(capture.text()).not.toContain('sensitive-reason');
      expect(capture.text()).not.toContain('relationships AS row');
    } finally {
      capture.restore();
    }
  });

  it('logs managed transaction retries without committing twice', async () => {
    const { _captureLogger } = await import('../../src/core/logger.js');
    const capture = _captureLogger();
    const { upsertRelations } = await import('../../src/core/neo4j/write-adapter.js');
    executeWrite.mockImplementationOnce(async (work: any) => {
      await work({ run: txRun });
      return await work({ run: txRun });
    });

    try {
      await upsertRelations('repo-a', [
        { type: 'CALLS', fromId: 'Function:caller', toId: 'Function:callee' },
      ]);

      const records = capture.records().filter((record) => record.operation === 'neo4j.relationships');
      expect(records.filter((record) => record.msg === 'Neo4j relationship transaction attempt started'))
        .toHaveLength(2);
      expect(records.filter((record) => record.msg === 'Neo4j relationship batch committed')).toHaveLength(1);
      expect(records.filter((record) => record.msg === 'Neo4j relationship transaction attempt started'))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ transactionAttempt: 1 }),
          expect.objectContaining({ transactionAttempt: 2 }),
        ]));
    } finally {
      capture.restore();
    }
  });

  it('logs relationship batch failures without swallowing them', async () => {
    const { _captureLogger } = await import('../../src/core/logger.js');
    const capture = _captureLogger();
    const { upsertRelations } = await import('../../src/core/neo4j/write-adapter.js');
    const failure = new Error('transaction failed');
    txRun.mockRejectedValueOnce(failure);

    try {
      await expect(
        upsertRelations('repo-a', [
          { type: 'CALLS', fromId: 'Function:caller', toId: 'Function:callee' },
        ]),
      ).rejects.toThrow(failure);

      const records = capture.records().filter((record) => record.operation === 'neo4j.relationships');
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({
          msg: 'Neo4j relationship batch failed',
          errorName: 'Error',
        }),
      ]));
      expect(capture.text()).not.toContain('transaction failed');
      expect(records.some((record) => record.msg === 'Neo4j relationship batch committed')).toBe(false);
    } finally {
      capture.restore();
    }
  });

  it('reports each successful relationship write batch with cumulative progress', async () => {
    const { upsertRelations } = await import('../../src/core/neo4j/write-adapter.js');
    const onProgress = vi.fn();
    const relationships = Array.from({ length: 1201 }, (_, i) => ({
      type: 'CALLS',
      fromId: `Function:caller-${i}`,
      toId: `Function:callee-${i}`,
      properties: { confidence: 1 },
    }));

    await upsertRelations('repo-a', relationships, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        operation: 'relationships',
        completedBatches: 1,
        totalBatches: 3,
        completedItems: 500,
        totalItems: 1201,
        relationshipType: 'CALLS',
      }),
      expect.objectContaining({ completedBatches: 2, completedItems: 1000 }),
      expect.objectContaining({ completedBatches: 3, completedItems: 1201 }),
    ]);
  });

  it('accepts USES relationship type emitted by scope resolution', async () => {
    const { upsertRelations } = await import('../../src/core/neo4j/write-adapter.js');

    await upsertRelations('repo-a', [
      {
        type: 'USES',
        fromId: 'Class:OrderService',
        toId: 'Class:OrderRepository',
        properties: { confidence: 0.9 },
      },
    ]);

    expect(txRun).toHaveBeenCalledWith(
      'UNWIND $relationships AS row MATCH (from:`CodeNode` {repoId: $repoId, id: row.fromId}) MATCH (to:`CodeNode` {repoId: $repoId, id: row.toId}) MERGE (from)-[r:`USES`]->(to) SET r += row.props',
      expect.objectContaining({ repoId: 'repo-a' }),
    );
  });

  it('accepts Vue event relationship types emitted by the Vue resolver', async () => {
    const { upsertRelations } = await import('../../src/core/neo4j/write-adapter.js');

    await upsertRelations('repo-a', [
      {
        type: 'BINDS_EVENT_HANDLER',
        fromId: 'Function:onPostSelected',
        toId: 'File:PostList.vue',
        properties: { confidence: 0.9 },
      },
      {
        type: 'EMITS_EVENT',
        fromId: 'File:PostList.vue',
        toId: 'File:PostList.vue',
        properties: { confidence: 0.9 },
      },
    ]);

    expect(txRun).toHaveBeenCalledWith(
      expect.stringContaining('MERGE (from)-[r:`BINDS_EVENT_HANDLER`]->(to)'),
      expect.objectContaining({ repoId: 'repo-a' }),
    );
    expect(txRun).toHaveBeenCalledWith(
      expect.stringContaining('MERGE (from)-[r:`EMITS_EVENT`]->(to)'),
      expect.objectContaining({ repoId: 'repo-a' }),
    );
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
