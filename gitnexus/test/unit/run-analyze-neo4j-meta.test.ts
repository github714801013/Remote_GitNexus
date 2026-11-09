import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../helpers/test-db.js';

describe('runFullAnalysis Neo4j metadata', () => {
  afterEach(() => {
    vi.doUnmock('../../src/core/neo4j/config.js');
    vi.doUnmock('../../src/core/neo4j/graph-loader.js');
    vi.doUnmock('../../src/core/neo4j/embedding-adapter.js');
    vi.doUnmock('../../src/core/ingestion/pipeline.js');
    vi.doUnmock('../../src/core/parse-cache-identity.js');
    vi.doUnmock('../../src/server/search.js');
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('persists storagePath so shared external slots stay owned', async () => {
    const tmpRepo = await createTempDir('gitnexus-neo4j-meta-');
    const tmpHome = await createTempDir('gitnexus-neo4j-home-');
    vi.stubEnv('GITNEXUS_STORAGE_BACKEND', 'neo4j');
    vi.stubEnv('GITNEXUS_HOME', tmpHome.dbPath);
    vi.doMock('../../src/core/neo4j/config.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/neo4j/config.js')>()),
      isNeo4jBackendEnabled: () => true,
    }));
    vi.doMock('../../src/core/ingestion/pipeline.js', () => ({
      runPipelineFromRepo: vi.fn(async (repoPath: string) => ({
        repoPath,
        graph: { forEachNode: () => undefined },
        totalFileCount: 0,
        resolutionOutcomes: [],
      })),
    }));
    // 跳过解析器指纹计算；本用例只覆盖最终 RepoMeta 的字段。
    vi.doMock('../../src/core/parse-cache-identity.js', () => ({
      resolveParseCacheIdentity: () => ({
        ok: true,
        identity: { base: 'test', pdg: 'test' },
        workerUrl: new URL('file:///test-worker.js'),
      }),
      finalizeParseCacheIdentity: (identity: unknown) => identity,
    }));
    vi.doMock('../../src/core/neo4j/graph-loader.js', () => ({
      countRepoGraphNodes: vi.fn(async () => 0),
      loadGraphToNeo4j: vi.fn(async () => ({ nodes: 1, edges: 0 })),
    }));
    vi.doMock('../../src/core/neo4j/embedding-adapter.js', () => ({
      countEmbeddings: vi.fn(async () => 0),
    }));
    vi.doMock('../../src/server/search.js', () => ({
      runNeo4jEmbeddingRepair: vi.fn(),
    }));

    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const { getStoragePaths, loadMeta } = await import('../../src/storage/repo-manager.js');

      await runFullAnalysis(
        tmpRepo.dbPath,
        { skipAgentsMd: true, skipSkills: true, noStats: true, useParseCache: false },
        { onProgress: () => {} },
      );

      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta?.storagePath).toBe(storagePath);
    } finally {
      await tmpRepo.cleanup();
      await tmpHome.cleanup();
    }
  }, 120_000);
});
