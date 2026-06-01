import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import * as zoektClient from '../../src/core/search/zoekt-client.js';
import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';

// Mock dependencies
vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn(),
  executeQuery: vi.fn(),
  executeParameterized: vi.fn(),
  closeLbug: vi.fn(),
  isLbugReady: vi.fn(() => true),
  isWriteQuery: vi.fn(() => false),
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn(async () => [
    {
      name: 'test-repo',
      path: '/path/to/repo',
      storagePath: '/path/to/storage',
      indexedAt: '2026-05-16',
      lastCommit: 'abc',
    },
  ]),
  cleanupOldKuzuFiles: vi.fn(async () => ({ found: false })),
  loadMeta: vi.fn(async () => ({ branch: 'main' })),
}));

// Mock ZoektClient using vi.spyOn to handle dynamic imports better
const mockSearch = vi.fn();
vi.spyOn(zoektClient, 'ZoektClient').mockImplementation(
  class {
    search = mockSearch;
    symbolSearch = vi.fn();
  } as any,
);

const mockLoadConfig = vi.spyOn(zoektClient, 'loadZoektConfig');

describe('LocalBackend.query with Zoekt integration', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    backend = new LocalBackend();
    // Force inject repo to bypass validate check in refreshRepos
    (backend as any).repos.set('test-repo', {
      id: 'test-repo',
      name: 'test-repo',
      repoPath: '/path/to/repo',
      storagePath: '/path/to/storage',
      lbugPath: '/path/to/storage/lbug',
      indexedAt: '2026-05-16',
      lastCommit: 'abc',
    });

    mockSearch.mockReset();
    mockLoadConfig.mockReset();
    vi.mocked(executeParameterized).mockClear();
    vi.mocked(executeParameterized).mockResolvedValue([]);

    // Default mocks for search helpers to avoid errors
    vi.spyOn(backend as any, 'bm25Search').mockResolvedValue({ results: [], ftsUsed: true });
    vi.spyOn(backend as any, 'semanticSearch').mockResolvedValue([]);
    // Bypass ensureInitialized
    vi.spyOn(backend as any, 'ensureInitialized').mockResolvedValue(undefined);
  });

  it('如果启用则调用 Zoekt search', async () => {
    mockLoadConfig.mockReturnValue({
      enabled: true,
      endpoints: ['http://localhost:6070'],
    });
    mockSearch.mockResolvedValue({
      matches: [
        {
          repository: 'test-repo',
          fileName: 'src/foo.ts',
          score: 1.0,
          lineMatches: [],
        },
      ],
      stats: { matchCount: 1, durationMs: 1 },
    });

    const result = await backend.callTool('query', { query: 'test', repo: 'test-repo' });

    expect(mockSearch).toHaveBeenCalled();
    expect(result.definitions).toContainEqual(
      expect.objectContaining({
        filePath: 'src/foo.ts',
        type: 'File',
      }),
    );
  });

  it('单仓库混合查询中 Zoekt DSL 只用于关键词检索，向量使用自然语言查询', async () => {
    mockLoadConfig.mockReturnValue({
      enabled: true,
      endpoints: ['http://localhost:6070'],
    });
    mockSearch.mockResolvedValue({
      matches: [],
      stats: { matchCount: 0, durationMs: 1 },
    });

    const semanticSpy = vi.spyOn(backend as any, 'semanticSearch');
    const bm25Spy = vi.spyOn(backend as any, 'bm25Search');

    await backend.callTool('query', {
      repo: 'test-repo',
      query: '年包次数已用完',
      zoekt: '"没有找到年包信息" OR "当前年包次数已用完" OR ("年包" "次数" "已用完")',
    });

    expect(bm25Spy).toHaveBeenCalledWith(
      expect.anything(),
      '"没有找到年包信息" OR "当前年包次数已用完" OR ("年包" "次数" "已用完")',
      expect.any(Number),
    );
    expect(mockSearch).toHaveBeenCalledWith(
      '"没有找到年包信息" OR "当前年包次数已用完" OR ("年包" "次数" "已用完")',
      {
        repoFilter: 'test-repo',
        maxDocDisplayCount: 50,
      },
    );
    expect(semanticSpy).toHaveBeenCalledWith(
      expect.anything(),
      '年包次数已用完',
      expect.any(Number),
    );
  });

  it('如果禁用则不调用 Zoekt search', async () => {
    mockLoadConfig.mockReturnValue({
      enabled: false,
      endpoints: [],
    });

    await backend.callTool('query', { query: 'test', repo: 'test-repo' });

    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('如果未提供 repo，则并行使用 Zoekt 和 embedding 发现多个项目并合并结果', async () => {
    mockLoadConfig.mockReturnValue({
      enabled: true,
      endpoints: ['http://localhost:6070'],
    });

    // Zoekt discovery only sees repo-1.
    mockSearch.mockResolvedValueOnce({
      matches: [
        {
          repository: 'repo-1',
          fileName: 'src/a.ts',
          score: 10.0,
          lineMatches: [{ line: 'handleError()', lineNumber: 12 }],
        },
      ],
      stats: { matchCount: 2, durationMs: 1 },
    });

    // Mock search calls for each repo's individual query
    mockSearch.mockResolvedValue({
      matches: [],
      stats: { matchCount: 0, durationMs: 1 },
    });

    // Add repos to backend
    (backend as any).repos.set('repo-1', { id: 'repo-1', name: 'repo-1', repoPath: '/p1' });
    (backend as any).repos.set('repo-2', { id: 'repo-2', name: 'repo-2', repoPath: '/p2' });

    vi.spyOn(backend as any, 'semanticSearch').mockImplementation(async (repo: any) =>
      repo.name === 'repo-2'
        ? [
            {
              nodeId: 'Function:src/vector.ts:semanticHit',
              name: 'semanticHit',
              type: 'Function',
              filePath: 'src/vector.ts',
              startLine: 20,
              endLine: 30,
              distance: 0.2,
            },
          ]
        : [],
    );

    // Spy on query to check what it returns for each repo
    const querySpy = vi.spyOn(backend as any, 'query');
    querySpy.mockImplementation(async (repo: any) => ({
      processes: [{ id: `proc-${repo.id}`, priority: 0.5, summary: `Process in ${repo.id}` }],
      process_symbols: [{ id: `sym-${repo.id}`, name: `Symbol in ${repo.id}` }],
      definitions: [{ name: `Def in ${repo.id}`, filePath: 'src/x.ts' }],
      timing: { wall: 10 },
    }));

    const result = await backend.callTool('query', { query: 'handleError' });

    // Should have called discovery search once
    expect(mockSearch.mock.calls[0][1]).not.toHaveProperty('repoFilter');

    // Should have called query for both repos even though Zoekt only found repo-1.
    expect(querySpy).toHaveBeenCalledTimes(2);
    expect(querySpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'repo-1' }),
      expect.any(Object),
    );
    expect(querySpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'repo-2' }),
      expect.any(Object),
    );

    // Results should be merged
    expect(result.processes).toHaveLength(2);
    expect(result.processes.map((p: any) => p.id)).toContain('proc-repo-1');
    expect(result.processes.map((p: any) => p.id)).toContain('proc-repo-2');

    expect(result.process_symbols).toHaveLength(2);
    expect(result.definitions).toHaveLength(2);
    expect(result.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repo: 'repo-1',
          filePath: 'src/a.ts',
          startLine: 12,
          source: 'zoekt',
        }),
        expect.objectContaining({
          repo: 'repo-2',
          filePath: 'src/vector.ts',
          startLine: 20,
          endLine: 30,
          source: 'vector',
        }),
      ]),
    );
  });

  it('跨仓库 embedding 发现应限制 LadybugDB 初始化并发但不跳过仓库', async () => {
    const previousConcurrency = process.env.GITNEXUS_CROSS_REPO_VECTOR_CONCURRENCY;
    process.env.GITNEXUS_CROSS_REPO_VECTOR_CONCURRENCY = '2';

    try {
      mockLoadConfig.mockReturnValue({
        enabled: false,
        endpoints: [],
      });
      (backend as any).repos.clear();

      for (let i = 1; i <= 5; i++) {
        (backend as any).repos.set(`repo-${i}`, {
          id: `repo-${i}`,
          name: `repo-${i}`,
          repoPath: `/p${i}`,
        });
      }

      let activeInitializations = 0;
      let maxActiveInitializations = 0;
      const initializedRepos: string[] = [];
      vi.spyOn(backend as any, 'ensureInitialized').mockImplementation(async (repoId: string) => {
        activeInitializations++;
        maxActiveInitializations = Math.max(maxActiveInitializations, activeInitializations);
        initializedRepos.push(repoId);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeInitializations--;
      });
      vi.spyOn(backend as any, 'semanticSearch').mockImplementation(async (repo: any) => [
        {
          name: `hit-${repo.id}`,
          filePath: `src/${repo.id}.ts`,
          startLine: 1,
          endLine: 2,
        },
      ]);

      const querySpy = vi.spyOn(backend as any, 'query');
      querySpy.mockImplementation(async (repo: any) => ({
        processes: [],
        process_symbols: [],
        definitions: [{ name: `Def in ${repo.id}`, filePath: `src/${repo.id}.ts` }],
        timing: { wall: 10 },
      }));

      const result = await backend.callTool('query', { query: 'handleError' });

      expect(maxActiveInitializations).toBeLessThanOrEqual(2);
      expect(initializedRepos).toHaveLength(5);
      expect(result.matched_repos).toEqual(['repo-1', 'repo-2', 'repo-3', 'repo-4', 'repo-5']);
      expect(querySpy).toHaveBeenCalledTimes(5);
    } finally {
      if (previousConcurrency === undefined) {
        delete process.env.GITNEXUS_CROSS_REPO_VECTOR_CONCURRENCY;
      } else {
        process.env.GITNEXUS_CROSS_REPO_VECTOR_CONCURRENCY = previousConcurrency;
      }
    }
  });

  it('并发跨仓库查询应错开同一项目的 discovery 和 query', async () => {
    const previousConcurrency = process.env.GITNEXUS_CROSS_REPO_VECTOR_CONCURRENCY;
    process.env.GITNEXUS_CROSS_REPO_VECTOR_CONCURRENCY = '2';

    try {
      mockLoadConfig.mockReturnValue({
        enabled: false,
        endpoints: [],
      });
      (backend as any).repos.clear();
      (backend as any).repos.set('repo-1', { id: 'repo-1', name: 'repo-1', repoPath: '/p1' });
      (backend as any).repos.set('repo-2', { id: 'repo-2', name: 'repo-2', repoPath: '/p2' });

      const activeByRepo = new Map<string, number>();
      let sameRepoOverlap = false;
      const runTracked = async <T>(repoId: string, work: () => Promise<T>): Promise<T> => {
        const active = activeByRepo.get(repoId) ?? 0;
        if (active > 0) sameRepoOverlap = true;
        activeByRepo.set(repoId, active + 1);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return await work();
        } finally {
          activeByRepo.set(repoId, (activeByRepo.get(repoId) ?? 1) - 1);
        }
      };

      vi.spyOn(backend as any, 'ensureInitialized').mockResolvedValue(undefined);
      vi.spyOn(backend as any, 'semanticSearch').mockImplementation(async (repo: any) =>
        runTracked(repo.id, async () => [
          {
            name: `hit-${repo.id}`,
            filePath: `src/${repo.id}.ts`,
            startLine: 1,
            endLine: 2,
          },
        ]),
      );

      const querySpy = vi.spyOn(backend as any, 'query');
      querySpy.mockImplementation(async (repo: any) =>
        runTracked(repo.id, async () => ({
          processes: [],
          process_symbols: [],
          definitions: [{ name: `Def in ${repo.id}`, filePath: `src/${repo.id}.ts` }],
          timing: { wall: 10 },
        })),
      );

      await Promise.all([
        backend.callTool('query', { query: 'handleError' }),
        backend.callTool('query', { query: 'handleError' }),
      ]);

      expect(sameRepoOverlap).toBe(false);
      expect(querySpy).toHaveBeenCalledTimes(4);
    } finally {
      if (previousConcurrency === undefined) {
        delete process.env.GITNEXUS_CROSS_REPO_VECTOR_CONCURRENCY;
      } else {
        process.env.GITNEXUS_CROSS_REPO_VECTOR_CONCURRENCY = previousConcurrency;
      }
    }
  });

  it('跨仓库 matches 截断应保留每个项目的代表命中', async () => {
    const highScoreMatches = Array.from({ length: 60 }, (_, index) => ({
      repo: 'repo-a',
      filePath: `src/a-${index}.ts`,
      source: 'vector' as const,
      score: 100 - index,
      startLine: index + 1,
      endLine: index + 1,
    }));
    const result = (backend as any).mergeQueryResults([
      { matches: highScoreMatches },
      {
        matches: [
          {
            repo: 'oa-pc',
            filePath: 'src/pages/after-service/order/components/spareMachine.vue',
            source: 'zoekt',
            score: 1,
            startLine: 1,
            endLine: 1,
          },
        ],
      },
    ]);

    expect(result.matches).toHaveLength(50);
    expect(result.matched_repos).toContain('oa-pc');
    expect(result.matches).toContainEqual(
      expect.objectContaining({
        repo: 'oa-pc',
        filePath: 'src/pages/after-service/order/components/spareMachine.vue',
      }),
    );
  });

  it('如果未提供 repo 且传入 zoekt，则使用 Zoekt 跨仓库发现并合并结果', async () => {
    mockLoadConfig.mockReturnValue({
      enabled: true,
      endpoints: ['http://localhost:6070'],
    });

    mockSearch.mockResolvedValueOnce({
      matches: [
        { repository: 'repo-1', fileName: 'src/a.ts', score: 10.0, lineMatches: [] },
        { repository: 'repo-2', fileName: 'src/b.ts', score: 9.0, lineMatches: [] },
      ],
      stats: { matchCount: 2, durationMs: 1 },
    });

    (backend as any).repos.set('repo-1', { id: 'repo-1', name: 'repo-1', repoPath: '/p1' });
    (backend as any).repos.set('repo-2', { id: 'repo-2', name: 'repo-2', repoPath: '/p2' });

    const querySpy = vi.spyOn(backend as any, 'query');
    querySpy.mockImplementation(async (repo: any) => ({
      processes: [{ id: `proc-${repo.id}`, priority: 0.5, summary: `Process in ${repo.id}` }],
      process_symbols: [],
      definitions: [],
      timing: { wall: 10 },
    }));

    const result = await backend.callTool('query', { zoekt: '"成为会员"' });

    expect(mockSearch).toHaveBeenCalledWith('"成为会员"', { maxDocDisplayCount: 200 });
    expect(querySpy).toHaveBeenCalledTimes(2);
    expect(result.processes.map((p: any) => p.id)).toEqual(['proc-repo-1', 'proc-repo-2']);
  });

  it('Zoekt 行命中应映射到覆盖该行的真实符号', async () => {
    mockLoadConfig.mockReturnValue({
      enabled: true,
      endpoints: ['http://localhost:6070'],
    });
    mockSearch.mockResolvedValue({
      matches: [
        {
          repository: 'test-repo',
          fileName: 'src/foo.ts',
          score: 10,
          lineMatches: [{ line: 'handleRequest()', lineNumber: 12, lineFragments: [] }],
        },
      ],
      stats: { matchCount: 1, durationMs: 1 },
    });
    vi.mocked(executeParameterized).mockImplementation(async (_repo: string, query: string) => {
      if (query.includes('$filePath0') && query.includes('$lineNumber0')) {
        return [
          {
            id: 'Function:src/foo.ts:handleRequest',
            name: 'handleRequest',
            type: 'Function',
            filePath: 'src/foo.ts',
            startLine: 10,
            endLine: 20,
          },
        ];
      }
      if (query.includes('STEP_IN_PROCESS')) {
        return [
          {
            pid: 'Process:HandleRequest',
            label: 'HandleRequest',
            heuristicLabel: 'HandleRequest',
            processType: 'intra_community',
            stepCount: 1,
            step: 1,
          },
        ];
      }
      return [];
    });

    const result = await backend.callTool('query', { query: 'handleRequest', repo: 'test-repo' });

    expect(result.process_symbols).toContainEqual(
      expect.objectContaining({
        id: 'Function:src/foo.ts:handleRequest',
        name: 'handleRequest',
        type: 'Function',
      }),
    );
    expect(result.definitions).not.toContainEqual(
      expect.objectContaining({ id: 'File:src/foo.ts' }),
    );
  });

  it('Zoekt 与向量同排名时按 source weight 优先排序', async () => {
    mockLoadConfig.mockReturnValue({
      enabled: true,
      endpoints: ['http://localhost:6070'],
    });
    mockSearch.mockResolvedValue({
      matches: [
        {
          repository: 'test-repo',
          fileName: 'src/zoekt.ts',
          score: 10,
          lineMatches: [{ line: 'exactSymbol()', lineNumber: 4, lineFragments: [] }],
        },
      ],
      stats: { matchCount: 1, durationMs: 1 },
    });
    vi.spyOn(backend as any, 'semanticSearch').mockResolvedValue([
      {
        nodeId: 'Function:src/vector.ts:conceptSymbol',
        name: 'conceptSymbol',
        type: 'Function',
        filePath: 'src/vector.ts',
        startLine: 1,
        endLine: 5,
      },
    ]);
    vi.mocked(executeParameterized).mockImplementation(
      async (_repo: string, query: string, params?: any) => {
        if (query.includes('$filePath0') && query.includes('$lineNumber0')) {
          return [
            {
              id: 'Function:src/zoekt.ts:exactSymbol',
              name: 'exactSymbol',
              type: 'Function',
              filePath: 'src/zoekt.ts',
              startLine: 1,
              endLine: 8,
            },
          ];
        }
        if (query.includes('STEP_IN_PROCESS')) {
          if (params?.nodeId === 'Function:src/zoekt.ts:exactSymbol') {
            return [
              {
                pid: 'Process:ZoektExact',
                label: 'ZoektExact',
                heuristicLabel: 'ZoektExact',
                processType: 'intra_community',
                stepCount: 1,
                step: 1,
              },
            ];
          }
          if (params?.nodeId === 'Function:src/vector.ts:conceptSymbol') {
            return [
              {
                pid: 'Process:VectorConcept',
                label: 'VectorConcept',
                heuristicLabel: 'VectorConcept',
                processType: 'intra_community',
                stepCount: 1,
                step: 1,
              },
            ];
          }
        }
        return [];
      },
    );

    const result = await backend.callTool('query', { query: 'exactSymbol', repo: 'test-repo' });

    expect(result.processes.map((process: any) => process.id)).toEqual([
      'Process:ZoektExact',
      'Process:VectorConcept',
    ]);
  });

  it('批量解析多个 Zoekt 行命中的真实符号', async () => {
    mockLoadConfig.mockReturnValue({
      enabled: true,
      endpoints: ['http://localhost:6070'],
    });
    mockSearch.mockResolvedValue({
      matches: [
        {
          repository: 'test-repo',
          fileName: 'src/a.ts',
          score: 10,
          lineMatches: [{ line: 'first()', lineNumber: 4, lineFragments: [] }],
        },
        {
          repository: 'test-repo',
          fileName: 'src/b.ts',
          score: 9,
          lineMatches: [{ line: 'second()', lineNumber: 8, lineFragments: [] }],
        },
      ],
      stats: { matchCount: 2, durationMs: 1 },
    });
    vi.mocked(executeParameterized).mockImplementation(
      async (_repo: string, query: string, params?: any) => {
        if (query.includes('$filePath0') && query.includes('$lineNumber0')) {
          expect(params).toMatchObject({
            filePath0: 'src/a.ts',
            lineNumber0: 4,
            filePath1: 'src/b.ts',
            lineNumber1: 8,
          });
          return [
            {
              id: 'Function:src/a.ts:first',
              name: 'first',
              type: 'Function',
              filePath: 'src/a.ts',
              startLine: 1,
              endLine: 5,
            },
            {
              id: 'Function:src/b.ts:second',
              name: 'second',
              type: 'Function',
              filePath: 'src/b.ts',
              startLine: 6,
              endLine: 10,
            },
          ];
        }
        if (query.includes('STEP_IN_PROCESS')) {
          return [
            {
              pid: `Process:${params?.nodeId}`,
              label: String(params?.nodeId),
              heuristicLabel: String(params?.nodeId),
              processType: 'intra_community',
              stepCount: 1,
              step: 1,
            },
          ];
        }
        return [];
      },
    );

    const result = await backend.callTool('query', { query: 'symbols', repo: 'test-repo' });

    const batchLookups = vi
      .mocked(executeParameterized)
      .mock.calls.filter(([, query]) => String(query).includes('$filePath0'));
    expect(batchLookups).toHaveLength(1);
    expect(result.process_symbols.map((symbol: any) => symbol.id)).toEqual(
      expect.arrayContaining(['Function:src/a.ts:first', 'Function:src/b.ts:second']),
    );
  });
});
