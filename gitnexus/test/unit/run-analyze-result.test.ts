import { describe, expect, it, vi } from 'vitest';

const fakePipelineResult = {
  graph: { marker: 'large-graph' },
  repoPath: '/repo',
  totalFileCount: 2,
  communityResult: { stats: { totalCommunities: 1 }, communities: [] },
  processResult: { stats: { totalProcesses: 1 } },
};

vi.mock('../../src/core/ingestion/pipeline.js', () => ({
  runPipelineFromRepo: vi.fn(async () => fakePipelineResult),
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  initLbug: vi.fn(async () => {}),
  loadGraphToLbug: vi.fn(async () => {}),
  getLbugStats: vi.fn(async () => ({ nodes: 3, edges: 4 })),
  executeQuery: vi.fn(async () => [{ cnt: 0 }]),
  executeWithReusedStatement: vi.fn(async () => {}),
  ensureFTSIndex: vi.fn(async () => {}),
  closeLbug: vi.fn(async () => {}),
  loadCachedEmbeddings: vi.fn(async () => ({ embeddingNodeIds: new Set(), embeddings: [] })),
  fetchExistingEmbeddingHashes: vi.fn(async () => new Map()),
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  getStoragePaths: vi.fn(() => ({
    storagePath: '/tmp/gitnexus-test-index',
    lbugPath: '/tmp/gitnexus-test-index/index.lbug',
  })),
  saveMeta: vi.fn(async () => {}),
  loadMeta: vi.fn(async () => null),
  addToGitignore: vi.fn(async () => {}),
  registerRepo: vi.fn(async () => 'repo'),
  cleanupOldKuzuFiles: vi.fn(async () => ({ found: false, needsReindex: false })),
}));

vi.mock('../../src/storage/git.js', () => ({
  getCurrentCommit: vi.fn(() => 'abc123'),
  getCurrentBranch: vi.fn(() => 'main'),
  getRemoteUrl: vi.fn(() => 'https://example.invalid/repo.git'),
  hasGitDir: vi.fn(() => true),
  getInferredRepoName: vi.fn(() => 'repo'),
}));

vi.mock('../../src/cli/ai-context.js', () => ({
  generateAIContextFiles: vi.fn(async () => {}),
}));

vi.mock('../../src/core/lbug/index-backup.js', () => ({
  backupLatestIndex: vi.fn(async () => ({ status: 'skipped-invalid-live' })),
  prepareEmbeddingShadowIndex: vi.fn(async () => {}),
  probeLbugFile: vi.fn(async () => ({ ok: true })),
  swapEmbeddingShadowToLive: vi.fn(async () => {}),
}));

vi.mock('../../src/core/neo4j/config.js', () => ({
  isNeo4jBackendEnabled: vi.fn(() => false),
}));

vi.mock('../../src/core/neo4j/graph-loader.js', () => ({
  countRepoGraphNodes: vi.fn(async () => 0),
  loadGraphToNeo4j: vi.fn(async () => ({ nodes: 5, edges: 6 })),
}));

vi.mock('../../src/core/neo4j/embedding-adapter.js', () => ({
  fetchExistingEmbeddingHashes: vi.fn(async () => new Map([['Function:cached', 'hash']])),
  loadEmbeddableNodes: vi.fn(async () => []),
  upsertEmbeddings: vi.fn(async () => {}),
  deleteEmbeddingsForNodes: vi.fn(async () => {}),
  ensureNeo4jEmbeddingIndex: vi.fn(async () => {}),
  countEmbeddings: vi.fn(async () => 7),
}));

vi.mock('../../src/core/embeddings/embedding-pipeline.js', () => ({
  runEmbeddingPipeline: vi.fn(async () => {}),
}));

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<any>('fs/promises');
  return {
    ...actual,
    rm: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ isFile: () => true })),
  };
});

describe('runFullAnalysis result shape', () => {
  it('omits pipelineResult by default', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const result = await runFullAnalysis(
      '/repo',
      { force: true, embeddings: false },
      {
        onProgress: vi.fn(),
        onLog: vi.fn(),
      },
    );

    expect(result.pipelineResult).toBeUndefined();
    expect(result.stats).toEqual({
      files: 2,
      nodes: 3,
      edges: 4,
      communities: 1,
      processes: 1,
      embeddings: 0,
    });
  });

  it('returns pipelineResult only when explicitly requested', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const result = await runFullAnalysis(
      '/repo',
      {
        force: true,
        embeddings: false,
        returnPipelineResult: true,
      },
      {
        onProgress: vi.fn(),
        onLog: vi.fn(),
      },
    );

    expect(result.pipelineResult).toBe(fakePipelineResult);
  });

  it('uses Neo4j graph loader when Neo4j backend is enabled', async () => {
    const neo4jConfig = await import('../../src/core/neo4j/config.js');
    vi.mocked(neo4jConfig.isNeo4jBackendEnabled).mockReturnValue(true);
    const neo4jLoader = await import('../../src/core/neo4j/graph-loader.js');
    const lbug = await import('../../src/core/lbug/lbug-adapter.js');
    vi.mocked(lbug.loadGraphToLbug).mockClear();
    vi.mocked(neo4jLoader.loadGraphToNeo4j).mockClear();

    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const result = await runFullAnalysis(
      '/repo',
      { force: true, embeddings: false },
      {
        onProgress: vi.fn(),
        onLog: vi.fn(),
      },
    );

    expect(neo4jLoader.loadGraphToNeo4j).toHaveBeenCalledWith('repo', fakePipelineResult.graph);
    expect(lbug.loadGraphToLbug).not.toHaveBeenCalled();
    expect(result.stats).toEqual({
      files: 2,
      nodes: 5,
      edges: 6,
      communities: 1,
      processes: 1,
      embeddings: 0,
    });
  });

  it('writes embeddings through Neo4j when Neo4j backend and embeddings are enabled', async () => {
    const neo4jConfig = await import('../../src/core/neo4j/config.js');
    vi.mocked(neo4jConfig.isNeo4jBackendEnabled).mockReturnValue(true);
    const embeddingPipeline = await import('../../src/core/embeddings/embedding-pipeline.js');
    const neo4jEmbeddings = await import('../../src/core/neo4j/embedding-adapter.js');
    const repoManager = await import('../../src/storage/repo-manager.js');
    vi.mocked(embeddingPipeline.runEmbeddingPipeline).mockClear();
    vi.mocked(neo4jEmbeddings.countEmbeddings).mockClear();
    vi.mocked(repoManager.saveMeta).mockClear();

    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const result = await runFullAnalysis(
      '/repo',
      { force: true, embeddings: true },
      {
        onProgress: vi.fn(),
        onLog: vi.fn(),
      },
    );

    expect(embeddingPipeline.runEmbeddingPipeline).toHaveBeenCalled();
    const pipelineArgs = vi.mocked(embeddingPipeline.runEmbeddingPipeline).mock.calls[0];
    expect(pipelineArgs[6]).toEqual(new Map([['Function:cached', 'hash']]));
    expect(pipelineArgs[7]).toMatchObject({
      loadNodes: expect.any(Function),
      insertEmbeddings: expect.any(Function),
      deleteEmbeddingsForNodeIds: expect.any(Function),
      ensureVectorIndex: expect.any(Function),
    });
    expect(neo4jEmbeddings.countEmbeddings).toHaveBeenCalledWith('repo');
    expect(result.stats.embeddings).toBe(7);
  });

  it('persists Neo4j metadata after graph load before embeddings finish', async () => {
    const neo4jConfig = await import('../../src/core/neo4j/config.js');
    vi.mocked(neo4jConfig.isNeo4jBackendEnabled).mockReturnValue(true);
    const embeddingPipeline = await import('../../src/core/embeddings/embedding-pipeline.js');
    const repoManager = await import('../../src/storage/repo-manager.js');
    vi.mocked(embeddingPipeline.runEmbeddingPipeline).mockClear();
    vi.mocked(repoManager.saveMeta).mockClear();
    vi.mocked(repoManager.registerRepo).mockClear();

    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    await runFullAnalysis(
      '/repo',
      { force: true, embeddings: true, registryBranch: 'release_9ji' },
      {
        onProgress: vi.fn(),
        onLog: vi.fn(),
      },
    );

    expect(repoManager.saveMeta).toHaveBeenCalledTimes(2);
    expect(repoManager.registerRepo).toHaveBeenCalledTimes(2);
    const firstMeta = vi.mocked(repoManager.saveMeta).mock.calls[0][1] as any;
    const finalMeta = vi.mocked(repoManager.saveMeta).mock.calls[1][1] as any;
    expect(firstMeta.branch).toBe('release_9ji');
    expect(firstMeta.stats.embeddings).toBe(0);
    expect(finalMeta.branch).toBe('release_9ji');
    expect(finalMeta.stats.embeddings).toBe(7);
    expect(vi.mocked(repoManager.saveMeta).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(embeddingPipeline.runEmbeddingPipeline).mock.invocationCallOrder[0],
    );
  });

  it('rebuilds Neo4j when meta is current but Neo4j has no repo nodes', async () => {
    const neo4jConfig = await import('../../src/core/neo4j/config.js');
    vi.mocked(neo4jConfig.isNeo4jBackendEnabled).mockReturnValue(true);
    const neo4jLoader = await import('../../src/core/neo4j/graph-loader.js');
    const repoManager = await import('../../src/storage/repo-manager.js');
    vi.mocked(repoManager.loadMeta).mockResolvedValueOnce({
      repoPath: '/repo',
      lastCommit: 'abc123',
      indexedAt: '2026-05-30T00:00:00.000Z',
      stats: { nodes: 3, edges: 4, embeddings: 0 },
    } as any);
    vi.mocked(neo4jLoader.countRepoGraphNodes).mockResolvedValueOnce(0);
    vi.mocked(neo4jLoader.loadGraphToNeo4j).mockClear();

    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const result = await runFullAnalysis(
      '/repo',
      { force: false, embeddings: false },
      {
        onProgress: vi.fn(),
        onLog: vi.fn(),
      },
    );

    expect(result.alreadyUpToDate).toBeUndefined();
    expect(neo4jLoader.countRepoGraphNodes).toHaveBeenCalledWith('repo');
    expect(neo4jLoader.loadGraphToNeo4j).toHaveBeenCalledWith('repo', fakePipelineResult.graph);
  });
});
