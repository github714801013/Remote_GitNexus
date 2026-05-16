import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import * as zoektClient from '../../src/core/search/zoekt-client.js';

// Mock dependencies
vi.mock('../../core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn(),
  executeQuery: vi.fn(),
  executeParameterized: vi.fn(),
  closeLbug: vi.fn(),
  isLbugReady: vi.fn(() => true),
  isWriteQuery: vi.fn(() => false),
}));

vi.mock('../../storage/repo-manager.js', () => ({
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

  it('如果禁用则不调用 Zoekt search', async () => {
    mockLoadConfig.mockReturnValue({
      enabled: false,
      endpoints: [],
    });

    await backend.callTool('query', { query: 'test', repo: 'test-repo' });

    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('如果未提供 repo 且存在多个项目，则尝试通过 Zoekt 自动发现多个项目并合并结果', async () => {
    mockLoadConfig.mockReturnValue({
      enabled: true,
      endpoints: ['http://localhost:6070'],
    });

    // Mock search for discovery: returns two repos
    mockSearch.mockResolvedValueOnce({
      matches: [
        { repository: 'repo-1', fileName: 'src/a.ts', score: 10.0, lineMatches: [] },
        { repository: 'repo-2', fileName: 'src/b.ts', score: 9.0, lineMatches: [] },
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

    // Should have called query for both repos
    expect(querySpy).toHaveBeenCalledTimes(2);

    // Results should be merged
    expect(result.processes).toHaveLength(2);
    expect(result.processes.map((p: any) => p.id)).toContain('proc-repo-1');
    expect(result.processes.map((p: any) => p.id)).toContain('proc-repo-2');

    expect(result.process_symbols).toHaveLength(2);
    expect(result.definitions).toHaveLength(2);
  });
});
