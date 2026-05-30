import { afterEach, describe, expect, it, vi } from 'vitest';

const txRun = vi.fn();
const executeWrite = vi.fn(async (work: any) => work({ run: txRun }));
const executeRead = vi.fn(async (work: any) => work({ run: txRun }));
const withNeo4jSession = vi.fn(async (work: any) => work({ executeRead, executeWrite }));

vi.mock('../../src/core/neo4j/driver.js', () => ({
  withNeo4jSession,
}));

const record = (values: Record<string, any>) => ({
  get: (key: string) => values[key],
});

describe('Neo4j embedding adapter', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fetches existing embedding content hashes by repoId', async () => {
    txRun.mockResolvedValueOnce({
      records: [
        record({ nodeId: 'Function:a', contentHash: 'hash-a' }),
        record({ nodeId: 'Function:b', contentHash: null }),
      ],
    });
    const { fetchExistingEmbeddingHashes } =
      await import('../../src/core/neo4j/embedding-adapter.js');

    const hashes = await fetchExistingEmbeddingHashes('repo-a');

    expect(txRun).toHaveBeenCalledWith(
      'MATCH (e:`CodeEmbedding` {repoId: $repoId}) RETURN e.nodeId AS nodeId, e.contentHash AS contentHash',
      { repoId: 'repo-a' },
    );
    expect(hashes).toEqual(
      new Map([
        ['Function:a', 'hash-a'],
        ['Function:b', ''],
      ]),
    );
  });

  it('batch upserts embedding chunks and links them to symbols', async () => {
    const { upsertEmbeddings } = await import('../../src/core/neo4j/embedding-adapter.js');

    await upsertEmbeddings('repo-a', [
      {
        nodeId: 'Function:a',
        chunkIndex: 0,
        startLine: 10,
        endLine: 20,
        embedding: [0.1, 0.2],
        contentHash: 'hash-a',
      },
    ]);

    expect(txRun).toHaveBeenCalledWith(
      'UNWIND $embeddings AS row MERGE (e:`CodeEmbedding` {repoId: $repoId, id: row.id}) SET e += row.props WITH e, row MATCH (n {repoId: $repoId, id: row.nodeId}) MERGE (e)-[:EMBEDS]->(n)',
      {
        repoId: 'repo-a',
        embeddings: [
          {
            id: 'Function:a:0',
            nodeId: 'Function:a',
            props: {
              repoId: 'repo-a',
              id: 'Function:a:0',
              nodeId: 'Function:a',
              chunkIndex: 0,
              startLine: 10,
              endLine: 20,
              embedding: [0.1, 0.2],
              contentHash: 'hash-a',
            },
          },
        ],
      },
    );
  });

  it('runs vector search and maps Neo4j records to semantic results', async () => {
    txRun.mockResolvedValueOnce({
      records: [
        record({
          nodeId: 'Function:a',
          repoId: 'repo-a',
          name: 'handler',
          type: 'Function',
          filePath: 'src/a.ts',
          chunkIndex: 1,
          startLine: 15,
          endLine: 25,
          score: 0.92,
        }),
      ],
    });
    const { semanticSearch } = await import('../../src/core/neo4j/embedding-adapter.js');

    const results = await semanticSearch('repo-a', [0.1, 0.2], 5);

    expect(txRun).toHaveBeenCalledWith(
      expect.stringContaining(
        "CALL db.index.vector.queryNodes('code_embedding_idx', $fetchLimit, $queryVector)",
      ),
      {
        repoIds: ['repo-a'],
        queryVector: [0.1, 0.2],
        fetchLimit: expect.objectContaining({ low: 25, high: 0 }),
        limit: expect.objectContaining({ low: 5, high: 0 }),
        minScore: 0.1,
      },
    );
    expect(results).toEqual([
      {
        repoId: 'repo-a',
        nodeId: 'Function:a',
        name: 'handler',
        type: 'Function',
        filePath: 'src/a.ts',
        chunkIndex: 1,
        startLine: 15,
        endLine: 25,
        score: 0.92,
        distance: 0.07999999999999996,
      },
    ]);
  });
});
