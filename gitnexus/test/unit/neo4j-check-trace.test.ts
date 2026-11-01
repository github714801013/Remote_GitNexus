import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
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

vi.mock('../../src/core/neo4j/read-adapter.js', () => ({
  executeReadCypher: vi.fn(async () => []),
}));

const repo = {
  id: 'repo-a',
  name: 'Repo A',
  repoPath: '/repo/a',
  storagePath: '/repo/a/.gitnexus',
  lbugPath: '/repo/a/.gitnexus/lbug',
  indexedAt: '2026-05-30',
  lastCommit: 'a',
};

describe('Neo4j check and trace', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(executeReadCypher).mockReset();
    vi.mocked(executeReadCypher).mockResolvedValue([]);
  });

  it('detects import cycles through Neo4j instead of LadybugDB', async () => {
    vi.mocked(executeReadCypher).mockImplementation(async (cypher: string) => {
      if (cypher.includes('-[r:IMPORTS]->')) {
        return [
          { source: 'src/a.ts', target: 'src/b.ts' },
          { source: 'src/b.ts', target: 'src/a.ts' },
        ];
      }
      return [];
    });
    const backend = new LocalBackend();

    const result = await (backend as any).check(repo, { cycles: true });

    expect(executeParameterized).not.toHaveBeenCalled();
    expect(result.status).toBe('cycles_found');
    expect(result.cycleCount).toBe(1);
    expect(new Set(result.cycles[0].files)).toEqual(new Set(['src/a.ts', 'src/b.ts']));
    const [cypher, params] = vi.mocked(executeReadCypher).mock.calls[0] as [string, any];
    expect(cypher).toContain('-[r:IMPORTS]->');
    expect(params.repoId).toBe('Repo A');
  });

  it('traces a call path through Neo4j instead of LadybugDB', async () => {
    vi.mocked(executeReadCypher).mockImplementation(async (cypher: string, params: any) => {
      if (cypher.includes('-[r]->(m:CodeNode')) {
        return [
          {
            sourceId: 'Function:from',
            id: 'Function:to',
            name: 'to',
            type: 'Function',
            filePath: 'src/to.ts',
            startLine: 3,
            edgeType: 'CALLS',
            confidence: 0.9,
          },
        ];
      }
      if (cypher.includes('n.name = $symName')) {
        const name = params.symName as string;
        return [
          {
            id: `Function:${name}`,
            name,
            type: 'Function',
            filePath: `src/${name}.ts`,
            startLine: 1,
            endLine: 2,
          },
        ];
      }
      return [];
    });
    const backend = new LocalBackend();

    const result = await (backend as any)._traceImpl(repo, { from: 'from', to: 'to' });

    expect(executeParameterized).not.toHaveBeenCalled();
    expect(result.status).toBe('ok');
    expect(result.hopCount).toBe(1);
    expect(result.hops.map((hop: any) => hop.name)).toEqual(['from', 'to']);
    expect(result.edges).toEqual([{ relType: 'CALLS', confidence: 0.9 }]);
  });
});
