import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
  beforeEach(() => {
    txRun.mockResolvedValue({ records: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fetches existing embedding content hashes by repoId', async () => {
    txRun.mockResolvedValueOnce({
      records: [
        record({ nodeId: 'Function:a', contentHash: 'hash-a', chunkCount: 2 }),
        record({ nodeId: 'Function:b', contentHash: null, chunkCount: 1 }),
      ],
    });
    const { fetchExistingEmbeddingHashes } =
      await import('../../src/core/neo4j/embedding-adapter.js');

    const hashes = await fetchExistingEmbeddingHashes('repo-a');

    expect(txRun).toHaveBeenCalledWith(
      'MATCH (e:`CodeEmbedding` {repoId: $repoId}) RETURN e.nodeId AS nodeId, head(collect(e.contentHash)) AS contentHash, count(e) AS chunkCount',
      { repoId: 'repo-a' },
    );
    expect(hashes).toEqual(
      new Map([
        ['Function:a', { contentHash: 'hash-a', chunkCount: 2 }],
        ['Function:b', { contentHash: '', chunkCount: 1 }],
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
        summaryText: '[中文业务摘要]\n业务词: 登录',
      },
    ]);

    expect(txRun).toHaveBeenCalledWith(
      expect.stringContaining(
        'MATCH (n:`Function`|`Method`|`Constructor`|`Class`|`Interface`|`Struct`|`Enum`|`Trait`|`Impl`|`Macro`|`Namespace`|`TypeAlias`|`Typedef`|`Const`|`Property`|`Record`|`Union`|`Static`|`Variable` {repoId: $repoId, id: row.nodeId})',
      ),
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
              summaryText: '[中文业务摘要]\n业务词: 登录',
            },
          },
        ],
      },
    );
  });

  it('hydrates missing node content from source file snippets', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-neo4j-embed-'));
    const sourcePath = path.join(repoPath, 'src', 'a.ts');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      [
        'const before = true;',
        'export function handler() {',
        '  const orderId = readOrderId();',
        '  return queryOrder(orderId);',
        '}',
        'const after = true;',
      ].join('\n'),
      'utf-8',
    );
    txRun.mockResolvedValueOnce({
      records: [
        record({
          id: 'Function:handler',
          name: 'handler',
          filePath: 'src/a.ts',
          content: '',
          startLine: 2,
          endLine: 5,
          isExported: true,
          description: null,
        }),
      ],
    });
    const { loadEmbeddableNodes } = await import('../../src/core/neo4j/embedding-adapter.js');

    try {
      const nodes = await loadEmbeddableNodes('repo-a', repoPath);

      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toMatchObject({
        id: 'Function:handler',
        name: 'handler',
        filePath: 'src/a.ts',
      });
      expect(nodes[0].content).toContain('export function handler()');
      expect(nodes[0].content).toContain('return queryOrder(orderId);');
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('keeps Neo4j node content when it is already populated', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-neo4j-embed-'));
    const sourcePath = path.join(repoPath, 'src', 'a.ts');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, 'export function fromDisk() {}', 'utf-8');
    txRun.mockResolvedValueOnce({
      records: [
        record({
          id: 'Function:handler',
          name: 'handler',
          filePath: 'src/a.ts',
          content: 'export function fromNeo4j() {}',
          startLine: 1,
          endLine: 1,
          isExported: true,
          description: null,
        }),
      ],
    });
    const { loadEmbeddableNodes } = await import('../../src/core/neo4j/embedding-adapter.js');

    try {
      const nodes = await loadEmbeddableNodes('repo-a', repoPath);

      expect(nodes).toHaveLength(1);
      expect(nodes[0].content).toBe('export function fromNeo4j() {}');
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('updates symbol descriptions by repo and label', async () => {
    const { updateNodeDescriptions } = await import('../../src/core/neo4j/embedding-adapter.js');

    await updateNodeDescriptions('repo-a', [
      {
        nodeId: 'Method:a',
        label: 'Method',
        description: '[中文业务摘要]\n意图: 获取短链',
      },
      {
        nodeId: 'Class:b',
        label: 'Class',
        description: '[中文业务摘要]\n意图: 订单请求体',
      },
    ]);

    expect(executeWrite).toHaveBeenCalledTimes(2);
    expect(txRun).toHaveBeenNthCalledWith(
      1,
      'UNWIND $updates AS row MATCH (n:`Method` {repoId: $repoId, id: row.nodeId}) SET n.description = row.description',
      {
        repoId: 'repo-a',
        updates: [
          {
            nodeId: 'Method:a',
            description: '[中文业务摘要]\n意图: 获取短链',
          },
        ],
      },
    );
    expect(txRun).toHaveBeenNthCalledWith(
      2,
      'UNWIND $updates AS row MATCH (n:`Class` {repoId: $repoId, id: row.nodeId}) SET n.description = row.description',
      {
        repoId: 'repo-a',
        updates: [
          {
            nodeId: 'Class:b',
            description: '[中文业务摘要]\n意图: 订单请求体',
          },
        ],
      },
    );
  });

  it('deletes stale embedding rows in 500-nodeId transactions', async () => {
    const { deleteEmbeddingsForNodes } = await import('../../src/core/neo4j/embedding-adapter.js');
    const nodeIds = Array.from({ length: 1201 }, (_, index) => `Function:${index}`);

    await deleteEmbeddingsForNodes('repo-a', nodeIds);

    expect(executeWrite).toHaveBeenCalledTimes(3);
    expect(txRun).toHaveBeenNthCalledWith(
      1,
      'MATCH (e:`CodeEmbedding` {repoId: $repoId}) WHERE e.nodeId IN $nodeIds DETACH DELETE e',
      { repoId: 'repo-a', nodeIds: nodeIds.slice(0, 500) },
    );
    expect(txRun).toHaveBeenNthCalledWith(
      2,
      'MATCH (e:`CodeEmbedding` {repoId: $repoId}) WHERE e.nodeId IN $nodeIds DETACH DELETE e',
      { repoId: 'repo-a', nodeIds: nodeIds.slice(500, 1000) },
    );
    expect(txRun).toHaveBeenNthCalledWith(
      3,
      'MATCH (e:`CodeEmbedding` {repoId: $repoId}) WHERE e.nodeId IN $nodeIds DETACH DELETE e',
      { repoId: 'repo-a', nodeIds: nodeIds.slice(1000) },
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
    expect(txRun.mock.calls[0][0]).toContain('MATCH (node)-[:EMBEDS]->(symbol)');
    expect(txRun.mock.calls[0][0]).not.toContain('MATCH (symbol {repoId: node.repoId');
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
