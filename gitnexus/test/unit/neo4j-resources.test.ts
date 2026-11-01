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

describe('Neo4j resources', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(executeReadCypher).mockReset();
    vi.mocked(executeReadCypher).mockResolvedValue([]);
  });

  it('reads tool definitions from Neo4j', async () => {
    vi.mocked(executeReadCypher).mockImplementation(async (cypher: string) => {
      if (cypher.includes('MATCH (n:Tool')) {
        return [
          {
            id: 'Tool:deploy',
            name: 'deploy',
            filePath: 'src/tools.ts',
            description: 'Deploys the app',
          },
        ];
      }
      return [];
    });
    const backend = new LocalBackend();

    const result = await (backend as any).toolMap(repo, {});

    expect(executeParameterized).not.toHaveBeenCalled();
    expect(result.total).toBe(1);
    expect(result.tools[0]).toMatchObject({ name: 'deploy', description: 'Deploys the app' });
  });

  it('lists clusters from Neo4j communities', async () => {
    vi.mocked(executeReadCypher).mockResolvedValue([
      { id: 'comm_1', label: null, heuristicLabel: 'Controller', cohesion: 0.5, symbolCount: 10 },
      { id: 'comm_2', label: null, heuristicLabel: 'Impl', cohesion: 0.8, symbolCount: 6 },
    ]);
    const backend = new LocalBackend();
    vi.spyOn(backend as any, 'resolveRepo').mockResolvedValue(repo);

    const result = await backend.queryClusters('Repo A', 10);

    expect(executeParameterized).not.toHaveBeenCalled();
    expect(result.clusters.map((c) => c.heuristicLabel)).toEqual(['Controller', 'Impl']);
  });

  it('reads cluster members from Neo4j', async () => {
    vi.mocked(executeReadCypher).mockImplementation(async (cypher: string) => {
      if (cypher.includes('MEMBER_OF')) {
        return [{ name: 'a', type: 'Method', filePath: 'src/a.ts' }];
      }
      if (cypher.includes('c:Community')) {
        return [
          { id: 'comm_1', label: null, heuristicLabel: 'Area', cohesion: 0.5, symbolCount: 8 },
        ];
      }
      return [];
    });
    const backend = new LocalBackend();
    vi.spyOn(backend as any, 'resolveRepo').mockResolvedValue(repo);

    const result = await backend.queryClusterDetail('Area', 'Repo A');

    expect(executeParameterized).not.toHaveBeenCalled();
    expect(result.cluster.symbolCount).toBe(8);
    expect(result.members).toEqual([{ name: 'a', type: 'Method', filePath: 'src/a.ts' }]);
  });

  it('finds api_impact request-function callers in Neo4j', async () => {
    vi.mocked(executeReadCypher).mockImplementation(async (cypher: string) => {
      if (cypher.includes('via.id IN $viaIds')) {
        return [
          {
            viaId: 'Function:req',
            viaName: 'req',
            callerName: 'caller',
            callerFile: 'src/c.ts',
          },
        ];
      }
      return [];
    });
    const backend = new LocalBackend();

    const callers = await (backend as any).fetchRequestFunctionCallers(repo, ['Function:req']);

    expect(executeParameterized).not.toHaveBeenCalled();
    expect(callers.get('Function:req')).toEqual([
      { viaId: 'Function:req', viaName: 'req', name: 'caller', filePath: 'src/c.ts' },
    ]);
  });
});
