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
    vi.mocked(executeReadCypher).mockReset();
    vi.mocked(executeReadCypher).mockResolvedValue([]);
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

  it('uses Neo4j file FTS instead of LadybugDB BM25 in Neo4j backend mode', async () => {
    const backend = new LocalBackend();
    vi.mocked(executeReadCypher).mockResolvedValueOnce([
      {
        id: 'File:Views/productkc/kcTransferList.cshtml',
        name: 'kcTransferList.cshtml',
        type: 'File',
        filePath: 'Views/productkc/kcTransferList.cshtml',
        score: 3.5,
      },
    ]);

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

    expect(result).toEqual({
      results: [
        {
          nodeId: 'File:Views/productkc/kcTransferList.cshtml',
          name: 'kcTransferList.cshtml',
          type: 'File',
          filePath: 'Views/productkc/kcTransferList.cshtml',
          bm25Score: 3.5,
        },
      ],
      ftsUsed: true,
    });
    expect(executeReadCypher).toHaveBeenCalledWith(expect.stringContaining('file_fts'), {
      repoId: 'Repo A',
      query: 'handler',
      limit: 10,
    });
    expect(executeQuery).not.toHaveBeenCalled();
    expect(executeParameterized).not.toHaveBeenCalled();
  });

  it('returns file_matches and path_diagnostics for path-like Neo4j query hits', async () => {
    const backend = new LocalBackend();
    vi.mocked(semanticSearch).mockResolvedValueOnce([]);
    vi.mocked(executeReadCypher).mockImplementation(async (query: string, params?: any) => {
      if (query.includes('db.index.fulltext.queryNodes')) {
        expect(params).toMatchObject({
          repoId: 'Repo A',
          query: 'oa999UI\\/Views\\/productkc\\/kcTransferList.cshtml',
        });
        return [
          {
            id: 'File:oa999UI/Views/productkc/kcTransferList.cshtml',
            name: 'kcTransferList.cshtml',
            type: 'File',
            filePath: 'oa999UI/Views/productkc/kcTransferList.cshtml',
            score: 8,
          },
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
      { query: 'oa999UI/Views/productkc/kcTransferList.cshtml', limit: 1 },
    );

    expect(result.file_matches).toEqual([
      expect.objectContaining({
        repo: 'Repo A',
        filePath: 'oa999UI/Views/productkc/kcTransferList.cshtml',
        name: 'kcTransferList.cshtml',
        type: 'File',
        source: 'bm25',
      }),
    ]);
    expect(result.path_diagnostics).toEqual(
      expect.objectContaining({
        backend: 'neo4j',
        exactPathFound: true,
        searchedHints: expect.arrayContaining([
          'oa999UI/Views/productkc/kcTransferList.cshtml',
          'kcTransferList.cshtml',
        ]),
        ftsAvailable: true,
      }),
    );
  });

  it('falls back to Neo4j File path matching when file FTS is unavailable', async () => {
    const backend = new LocalBackend();
    vi.mocked(semanticSearch).mockResolvedValueOnce([]);
    vi.mocked(executeReadCypher).mockImplementation(async (query: string, params?: any) => {
      if (query.includes('db.index.fulltext.queryNodes')) {
        throw new Error('There is no such fulltext schema index: file_fts');
      }
      if (query.includes('UNWIND $hints AS hint')) {
        expect(params.repoIds).toEqual(expect.arrayContaining(['Repo A']));
        return [
          {
            id: 'File:oa999UI/Views/productKC/kcTransferList.cshtml',
            name: 'kcTransferList.cshtml',
            type: 'File',
            filePath: 'oa999UI/Views/productKC/kcTransferList.cshtml',
            score: 100,
          },
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
      {
        query: 'oa999UI/Views/productKC/kcTransferList.cshtml 批量审核',
        zoekt: '"oa999UI/Views/productKC/kcTransferList.cshtml" OR "批量审核"',
        limit: 1,
      },
    );

    expect(result.file_matches).toEqual([
      expect.objectContaining({
        repo: 'Repo A',
        filePath: 'oa999UI/Views/productKC/kcTransferList.cshtml',
        name: 'kcTransferList.cshtml',
        type: 'File',
        source: 'path',
        matchKind: 'exact_path',
      }),
    ]);
    expect(result.path_diagnostics).toEqual(
      expect.objectContaining({
        backend: 'neo4j',
        exactPathFound: true,
        searchedHints: expect.arrayContaining([
          'oa999UI/Views/productKC/kcTransferList.cshtml',
          'kcTransferList.cshtml',
        ]),
        ftsAvailable: false,
      }),
    );
  });

  it('derives Neo4j repoId candidates for worktree repos', async () => {
    const backend = new LocalBackend();
    vi.mocked(semanticSearch).mockResolvedValueOnce([]);
    vi.mocked(executeReadCypher).mockImplementation(async (query: string, params?: any) => {
      if (query.includes('db.index.fulltext.queryNodes')) {
        throw new Error('There is no such fulltext schema index: file_fts');
      }
      if (query.includes('UNWIND $hints AS hint')) {
        expect(params).toMatchObject({
          repoIds: expect.arrayContaining(['Repo A']),
          hints: expect.arrayContaining([
            'oa999ui/views/productkc/kctransferlist.cshtml',
            'kctransferlist.cshtml',
          ]),
        });
        return [
          {
            id: 'File:oa999UI/Views/productKC/kcTransferList.cshtml',
            name: 'kcTransferList.cshtml',
            type: 'File',
            filePath: 'oa999UI/Views/productKC/kcTransferList.cshtml',
            score: 100,
          },
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
      {
        query: 'oa999UI/Views/productKC/kcTransferList.cshtml 批量审核',
        zoekt: '"oa999UI/Views/productKC/kcTransferList.cshtml" OR "批量审核"',
        limit: 1,
      },
    );

    expect(result.file_matches).toEqual([
      expect.objectContaining({
        repo: 'Repo A',
        filePath: 'oa999UI/Views/productKC/kcTransferList.cshtml',
        name: 'kcTransferList.cshtml',
        type: 'File',
        source: 'path',
        matchKind: 'exact_path',
      }),
    ]);
    expect(result.path_diagnostics).toEqual(
      expect.objectContaining({
        backend: 'neo4j',
        exactPathFound: true,
        searchedHints: expect.arrayContaining([
          'oa999UI/Views/productKC/kcTransferList.cshtml',
          'kcTransferList.cshtml',
        ]),
        ftsAvailable: false,
      }),
    );
  });

  it('derives Neo4j repoId candidates for worktree repos', async () => {
    const backend = new LocalBackend();

    const getCandidates = (repo: any) => (backend as any).deriveNeo4jRepoIdCandidates(repo);

    const devOanew = {
      id: 'dev-oanew',
      name: 'dev-oanew',
      repoPath: '/projects/OA_CSharp/dev-oanew',
      storagePath: '/projects/OA_CSharp/dev-oanew/.gitnexus',
      lbugPath: '/projects/OA_CSharp/dev-oanew/.gitnexus/lbug',
      indexedAt: '1',
      lastCommit: 'a',
    };
    expect(getCandidates(devOanew)).toEqual(expect.arrayContaining(['dev-oanew', 'oanew']));

    const itengSaasoanew = {
      id: 'iteng-saasoanew',
      name: 'iteng-saasoanew',
      repoPath: '/projects/OA_CSharp/iteng-saasoanew',
      storagePath: '/projects/OA_CSharp/iteng-saasoanew/.gitnexus',
      lbugPath: '/projects/OA_CSharp/iteng-saasoanew/.gitnexus/lbug',
      indexedAt: '2',
      lastCommit: 'b',
    };
    expect(getCandidates(itengSaasoanew)).toEqual(
      expect.arrayContaining(['iteng-saasoanew', 'saasoanew']),
    );

    // Non-worktree repos should only have their own name
    const oanew = {
      id: 'oanew',
      name: 'oanew',
      repoPath: '/projects/OA_CSharp/oanew',
      storagePath: '/projects/OA_CSharp/oanew/.gitnexus',
      lbugPath: '/projects/OA_CSharp/oanew/.gitnexus/lbug',
      indexedAt: '3',
      lastCommit: 'c',
    };
    const candidates = getCandidates(oanew);
    expect(candidates).toContain('oanew');
    expect(candidates).toHaveLength(1); // no extra candidates for base repo
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

    expect(executeReadCypher).toHaveBeenCalledTimes(3);
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
