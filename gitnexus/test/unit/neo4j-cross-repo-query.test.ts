import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import * as zoektClient from '../../src/core/search/zoekt-client.js';
import { semanticSearch, semanticSearchMany } from '../../src/core/neo4j/embedding-adapter.js';
import { embedQuery } from '../../src/mcp/core/embedder.js';
import { executeParameterized, executeQuery, initLbug } from '../../src/core/lbug/pool-adapter.js';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn(),
  executeQuery: vi.fn(),
  executeParameterized: vi.fn(),
  closeLbug: vi.fn(),
  isLbugReady: vi.fn(() => true),
  isWriteQuery: vi.fn(() => false),
}));

vi.mock('../../src/core/neo4j/config.js', () => ({
  isNeo4jBackendEnabled: vi.fn(() => true),
}));

vi.mock('../../src/core/neo4j/embedding-adapter.js', () => ({
  semanticSearch: vi.fn(async () => [
    {
      repoId: 'Repo A',
      nodeId: 'Function:a',
      name: 'handlerA',
      type: 'Function',
      filePath: 'src/a.ts',
      startLine: 1,
      endLine: 5,
    },
  ]),
  semanticSearchMany: vi.fn(async () => [
    {
      repoId: 'Repo A',
      nodeId: 'Function:a',
      name: 'handlerA',
      filePath: 'src/a.ts',
      startLine: 1,
      endLine: 5,
    },
    {
      repoId: 'Repo B',
      nodeId: 'Function:b',
      name: 'handlerB',
      filePath: 'src/b.ts',
      startLine: 2,
      endLine: 6,
    },
  ]),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn(async () => [0.1, 0.2]),
}));

vi.mock('../../src/core/neo4j/read-adapter.js', () => ({
  executeReadCypher: vi.fn(async () => []),
}));

vi.spyOn(zoektClient, 'loadZoektConfig').mockReturnValue({
  enabled: false,
  endpoints: [],
});

describe('Neo4j cross-repo vector discovery', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('queries Neo4j once with all repo ids', async () => {
    const backend = new LocalBackend();
    const repos = [
      {
        id: 'repo-a',
        name: 'Repo A',
        repoPath: '/repo/a',
        storagePath: '/repo/a/.gitnexus',
        lbugPath: '/repo/a/.gitnexus/lbug',
        indexedAt: '2026-05-30',
        lastCommit: 'a',
      },
      {
        id: 'repo-b',
        name: 'Repo B',
        repoPath: '/repo/b',
        storagePath: '/repo/b/.gitnexus',
        lbugPath: '/repo/b/.gitnexus/lbug',
        indexedAt: '2026-05-30',
        lastCommit: 'b',
      },
    ];

    const candidates = await (backend as any).discoverQueryCandidates('handler', repos);

    expect(embedQuery).toHaveBeenCalledWith('handler');
    expect(semanticSearchMany).toHaveBeenCalledWith(['Repo A', 'Repo B'], [0.1, 0.2], 10);
    expect(semanticSearchMany).not.toHaveBeenCalledWith(
      'repo-a',
      expect.anything(),
      expect.anything(),
    );
    expect(semanticSearchMany).not.toHaveBeenCalledWith(
      'repo-b',
      expect.anything(),
      expect.anything(),
    );
    expect(candidates.map((candidate: any) => candidate.repo.name)).toEqual(['Repo A', 'Repo B']);
  });

  it('does not use LadybugDB BM25 in Neo4j backend mode', async () => {
    const backend = new LocalBackend();

    const result = await (backend as any).bm25Search(
      {
        id: 'repo-a',
        name: 'Repo A',
        repoPath: '/repo/a',
        storagePath: '/repo/a/.gitnexus',
        lbugPath: '/repo/a/.gitnexus/lbug',
        indexedAt: '2026-05-30',
        lastCommit: 'a',
      },
      'handler',
      10,
    );

    expect(result).toEqual({ results: [], ftsUsed: true });
    expect(executeQuery).not.toHaveBeenCalled();
    expect(executeParameterized).not.toHaveBeenCalled();
  });

  it('does not initialize LadybugDB for query in Neo4j backend mode', async () => {
    const backend = new LocalBackend();

    const result = await (backend as any).query(
      {
        id: 'repo-a',
        name: 'Repo A',
        repoPath: '/repo/a',
        storagePath: '/repo/a/.gitnexus',
        lbugPath: '/repo/a/.gitnexus/lbug',
        indexedAt: '2026-05-30',
        lastCommit: 'a',
      },
      { query: 'handler', limit: 1 },
    );

    expect(initLbug).not.toHaveBeenCalled();
    expect(result).toHaveProperty('definitions');
  });

  it('does not initialize LadybugDB from the shared initializer in Neo4j backend mode', async () => {
    const backend = new LocalBackend();
    const repo = {
      id: 'repo-a',
      name: 'Repo A',
      repoPath: '/repo/a',
      storagePath: '/repo/a/.gitnexus',
      lbugPath: '/repo/a/.gitnexus/lbug',
      indexedAt: '2026-05-30',
      lastCommit: 'a',
    };
    (backend as any).repos.set(repo.id, repo);

    await (backend as any).ensureInitialized(repo.id);

    expect(initLbug).not.toHaveBeenCalled();
  });

  it('uses Neo4j cross-repo discovery directly for repo-less query calls', async () => {
    const backend = new LocalBackend();
    const repos = [
      {
        id: 'repo-a',
        name: 'Repo A',
        repoPath: '/repo/a',
        storagePath: '/repo/a/.gitnexus',
        lbugPath: '/repo/a/.gitnexus/lbug',
        indexedAt: '2026-05-30',
        lastCommit: 'a',
      },
      {
        id: 'repo-b',
        name: 'Repo B',
        repoPath: '/repo/b',
        storagePath: '/repo/b/.gitnexus',
        lbugPath: '/repo/b/.gitnexus/lbug',
        indexedAt: '2026-05-30',
        lastCommit: 'b',
      },
    ];
    repos.forEach((repo) => (backend as any).repos.set(repo.id, repo));

    const result = await backend.callTool('query', { query: 'handler', limit: 2 });

    expect(semanticSearchMany).toHaveBeenCalledWith(['Repo A', 'Repo B'], [0.1, 0.2], 10);
    expect(semanticSearch).not.toHaveBeenCalled();
    expect(initLbug).not.toHaveBeenCalled();
    expect(result.matched_repos).toEqual(['Repo A', 'Repo B']);
    expect(result.matches).toHaveLength(2);
    expect(result.definitions.map((definition: any) => definition.name)).toEqual([
      'handlerA',
      'handlerB',
    ]);
  });
});
