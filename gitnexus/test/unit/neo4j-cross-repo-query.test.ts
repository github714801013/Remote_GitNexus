import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import * as zoektClient from '../../src/core/search/zoekt-client.js';
import { semanticSearch, semanticSearchMany } from '../../src/core/neo4j/embedding-adapter.js';
import { embedQuery } from '../../src/mcp/core/embedder.js';
import { executeParameterized, executeQuery, initLbug } from '../../src/core/lbug/pool-adapter.js';
import { executeReadCypher } from '../../src/core/neo4j/read-adapter.js';

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

  it('uses semantic text instead of raw Zoekt syntax for vector discovery', async () => {
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
    ];

    await (backend as any).discoverQueryCandidates(
      {
        keywordQuery: '"没有找到年包信息" OR "当前年包次数已用完" OR ("年包" "次数" "已用完")',
        semanticQuery: '没有找到年包信息 当前年包次数已用完 年包 次数 已用完',
      },
      repos,
    );

    expect(embedQuery).toHaveBeenCalledWith('没有找到年包信息 当前年包次数已用完 年包 次数 已用完');
    expect(semanticSearchMany).toHaveBeenCalledWith(['Repo A'], [0.1, 0.2], 5);
  });

  it('keeps raw Zoekt syntax out of vector search for repo-less query calls', async () => {
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
    (backend as any).repos.set('repo-b', {
      id: 'repo-b',
      name: 'Repo B',
      repoPath: '/repo/b',
      storagePath: '/repo/b/.gitnexus',
      lbugPath: '/repo/b/.gitnexus/lbug',
      indexedAt: '2026-05-30',
      lastCommit: 'b',
    });

    await backend.callTool('query', {
      query: '年包次数已用完',
      zoekt: '"没有找到年包信息" OR "当前年包次数已用完" OR ("年包" "次数" "已用完")',
    });

    expect(embedQuery).toHaveBeenCalledWith('年包次数已用完');
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

  it('批量回填 Neo4j query 命中符号的流程和社区信息', async () => {
    const backend = new LocalBackend();
    vi.spyOn(backend as any, 'semanticSearch').mockResolvedValueOnce([
      {
        repoId: 'Repo A',
        nodeId: 'Function:a',
        name: 'handlerA',
        type: 'Function',
        filePath: 'src/a.ts',
        startLine: 1,
        endLine: 5,
      },
      {
        repoId: 'Repo A',
        nodeId: 'Function:b',
        name: 'handlerB',
        type: 'Function',
        filePath: 'src/b.ts',
        startLine: 10,
        endLine: 20,
      },
    ]);
    vi.mocked(executeReadCypher).mockImplementation(async (query: string, params?: any) => {
      if (query.includes('STEP_IN_PROCESS')) {
        expect(query).toContain('UNWIND $nodeIds AS nodeId');
        expect(query).toContain('MATCH (n:CodeNode {repoId: $repoId, id: nodeId})');
        expect(params).toEqual({ repoId: 'Repo A', nodeIds: ['Function:a', 'Function:b'] });
        return [
          {
            nodeId: 'Function:a',
            pid: 'Process:A',
            label: 'Process A',
            heuristicLabel: 'Process A',
            processType: 'intra_community',
            stepCount: 2,
            step: 1,
          },
          {
            nodeId: 'Function:b',
            pid: 'Process:B',
            label: 'Process B',
            heuristicLabel: 'Process B',
            processType: 'intra_community',
            stepCount: 2,
            step: 2,
          },
        ];
      }
      if (query.includes('MEMBER_OF')) {
        expect(query).toContain('UNWIND $nodeIds AS nodeId');
        expect(query).toContain('MATCH (n:CodeNode {repoId: $repoId, id: nodeId})');
        expect(params).toEqual({ repoId: 'Repo A', nodeIds: ['Function:a', 'Function:b'] });
        return [
          { nodeId: 'Function:a', cohesion: 0.7, module: 'Module A' },
          { nodeId: 'Function:b', cohesion: 0.4, module: 'Module B' },
        ];
      }
      return [];
    });

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
      { query: 'handler', limit: 1, max_symbols: 2 },
    );

    expect(executeReadCypher).toHaveBeenCalledTimes(2);
    expect(result.processes.map((process: any) => process.id)).toEqual(['Process:A']);
    expect(result.process_symbols.map((symbol: any) => symbol.id)).toContain('Function:a');
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
