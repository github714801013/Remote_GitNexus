import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddableNode } from '../../src/core/embeddings/types.js';
import { _captureLogger, type LoggerCapture } from '../../src/core/logger.js';

const contentHashForNode = vi.fn((node: EmbeddableNode) => `hash:${node.id}`);
const shouldSummarizeNode = vi.fn(() => false);
const embedBatch = vi.fn();
const embeddingToArray = vi.fn((vector: Float32Array) => Array.from(vector));
const buildNeo4jEmbeddingText = vi.fn(async (node: EmbeddableNode) => ({
  embeddingText: node.content,
}));
const countEmbeddings = vi.fn(async () => 3);
const deleteEmbeddingsForNodes = vi.fn(async () => {});
const ensureNeo4jEmbeddingIndex = vi.fn(async () => {});
const fetchExistingEmbeddingHashes = vi.fn(async () => new Map());
const countEmbeddableNodes = vi.fn(async () => 0);
const loadEmbeddableNodeBatches = vi.fn(async function* () {});
const updateNodeDescriptions = vi.fn(async () => {});
const upsertEmbeddings = vi.fn(async () => {});

vi.mock('../../src/core/embeddings/embedding-pipeline.js', () => ({
  contentHashForNode,
}));

vi.mock('../../src/core/embeddings/keyword-summary.js', () => ({
  shouldSummarizeNode,
}));

vi.mock('../../src/core/embeddings/embedder.js', () => ({
  embedBatch,
  embeddingToArray,
}));

vi.mock('../../src/server/neo4j-embedding-text.js', () => ({
  buildNeo4jEmbeddingText,
}));

vi.mock('../../src/core/neo4j/embedding-adapter.js', () => ({
  countEmbeddings,
  deleteEmbeddingsForNodes,
  ensureNeo4jEmbeddingIndex,
  fetchExistingEmbeddingHashes,
  countEmbeddableNodes,
  loadEmbeddableNodeBatches,
  updateNodeDescriptions,
  upsertEmbeddings,
}));

const node = (id: string, content = id): EmbeddableNode => ({
  id,
  name: id,
  label: 'Function',
  filePath: `${id}.ts`,
  content,
  startLine: 1,
  endLine: 2,
});

describe('Neo4j embedding repair resilience', () => {
  let logs: LoggerCapture;

  afterEach(() => {
    logs?.restore();
    vi.clearAllMocks();
    delete process.env.GITNEXUS_EMBEDDING_REPAIR_REPO_COOLDOWN_MS;
    delete process.env.GITNEXUS_EMBEDDING_REPAIR_BATCH_SIZE;
  });

  it('uses the configured repair batch size', async () => {
    process.env.GITNEXUS_EMBEDDING_REPAIR_BATCH_SIZE = '1';
    countEmbeddableNodes.mockResolvedValue(2);
    loadEmbeddableNodeBatches.mockImplementationOnce(async function* () {
      yield [node('node-a'), node('node-b')];
    });
    embedBatch.mockImplementation(async (texts: string[]) =>
      texts.map(() => new Float32Array([1, 2, 3])),
    );

    const { runNeo4jEmbeddingRepair } = await import('../../src/server/search.js');
    await expect(runNeo4jEmbeddingRepair('repo-batch-size', vi.fn())).resolves.toBe(3);

    expect(embedBatch).toHaveBeenNthCalledWith(1, ['node-a']);
    expect(embedBatch).toHaveBeenNthCalledWith(2, ['node-b']);
  });
  it('splits failed batches and skips only nodes that still fail individually', async () => {
    logs = _captureLogger('warn');
    countEmbeddableNodes.mockResolvedValueOnce(4);
    loadEmbeddableNodeBatches.mockImplementationOnce(async function* () {
      yield [node('good-a'), node('bad-node', 'bad')];
      yield [node('good-b'), node('good-c')];
    });
    embedBatch.mockImplementation(async (texts: string[]) => {
      if (texts.includes('bad')) {
        throw new Error('Embedding endpoint returned 500 (http://embed/embeddings, batch 0)');
      }
      return texts.map(() => new Float32Array([1, 2, 3]));
    });

    const { runNeo4jEmbeddingRepair } = await import('../../src/server/search.js');
    await expect(runNeo4jEmbeddingRepair('repo-a', vi.fn())).resolves.toBe(3);

    const upsertedNodeIds = upsertEmbeddings.mock.calls.flatMap(([, updates]) =>
      updates.map((update: { nodeId: string }) => update.nodeId),
    );
    expect(upsertedNodeIds).toEqual(['good-a', 'good-b', 'good-c']);
    expect(upsertedNodeIds).not.toContain('bad-node');
    expect(
      logs
        .records()
        .some((record) => record.msg === 'Neo4j embedding repair batch failed; splitting batch'),
    ).toBe(true);
    expect(
      logs
        .records()
        .some(
          (record) =>
            record.msg === 'Neo4j embedding repair skipped node after repeated embedding failures',
        ),
    ).toBe(true);
  });

  it('does not retry later batches after a systemic endpoint failure', async () => {
    countEmbeddableNodes.mockResolvedValue(4);
    loadEmbeddableNodeBatches.mockImplementationOnce(async function* () {
      yield [node('node-a'), node('node-b'), node('node-c'), node('node-d')];
    });
    embedBatch.mockRejectedValue(
      new Error('Embedding request failed (http://embed/embeddings, batch 0): fetch failed'),
    );

    const { runNeo4jEmbeddingRepair } = await import('../../src/server/search.js');
    await expect(runNeo4jEmbeddingRepair('repo-systemic-batch', vi.fn())).rejects.toThrow(
      'failed for all 4 nodes',
    );
    expect(embedBatch).toHaveBeenCalledTimes(1);
  });
  it('does not recursively split a systemic endpoint failure', async () => {
    countEmbeddableNodes.mockResolvedValue(4);
    loadEmbeddableNodeBatches.mockImplementationOnce(async function* () {
      yield [node('node-a'), node('node-b'), node('node-c'), node('node-d')];
    });
    embedBatch.mockRejectedValue(
      new Error('Embedding request failed (http://embed/embeddings, batch 0): fetch failed'),
    );

    const { runNeo4jEmbeddingRepair } = await import('../../src/server/search.js');
    await expect(runNeo4jEmbeddingRepair('repo-network-failure', vi.fn())).rejects.toThrow(
      'failed for all 4 nodes',
    );
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(embedBatch).toHaveBeenCalledWith(['node-a', 'node-b', 'node-c', 'node-d']);
    expect(deleteEmbeddingsForNodes).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent repair requests for the same repo', async () => {
    countEmbeddableNodes.mockResolvedValue(1);
    loadEmbeddableNodeBatches.mockImplementationOnce(async function* () {
      yield [node('node-dedup')];
    });

    let releaseEmbedding!: () => void;
    embedBatch.mockImplementationOnce(
      () =>
        new Promise<Float32Array[]>((resolve) => {
          releaseEmbedding = () => resolve([new Float32Array([1, 2, 3])]);
        }),
    );

    const { runNeo4jEmbeddingRepair } = await import('../../src/server/search.js');
    const first = runNeo4jEmbeddingRepair('repo-dedup', vi.fn());
    const second = runNeo4jEmbeddingRepair('repo-dedup', vi.fn());

    await vi.waitFor(() => expect(embedBatch).toHaveBeenCalledTimes(1));
    releaseEmbedding();

    await expect(Promise.all([first, second])).resolves.toEqual([3, 3]);
    expect(loadEmbeddableNodeBatches).toHaveBeenCalledTimes(1);
  });

  it('puts a repo into cooldown when all nodes fail embedding repair', async () => {
    logs = _captureLogger('warn');
    process.env.GITNEXUS_EMBEDDING_REPAIR_REPO_COOLDOWN_MS = '60000';
    countEmbeddableNodes.mockResolvedValue(2);
    loadEmbeddableNodeBatches.mockImplementation(async function* () {
      yield [node('bad-a'), node('bad-b')];
    });
    embedBatch.mockRejectedValue(
      new Error('Embedding endpoint returned 500 (http://embed/embeddings, batch 0)'),
    );

    const { runNeo4jEmbeddingRepair } = await import('../../src/server/search.js');
    await expect(runNeo4jEmbeddingRepair('repo-cooldown', vi.fn())).rejects.toThrow(
      'failed for all 2 nodes',
    );
    await expect(runNeo4jEmbeddingRepair('repo-cooldown', vi.fn())).rejects.toThrow('cooling down');
    expect(loadEmbeddableNodeBatches).toHaveBeenCalledTimes(1);
  });
});
