import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import {
  executeReadCypher,
  findImpact,
  findSymbolContext,
} from '../../src/core/neo4j/read-adapter.js';
import { executeParameterized, initLbug } from '../../src/core/lbug/pool-adapter.js';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn(),
  executeQuery: vi.fn(),
  executeParameterized: vi.fn(),
  closeLbug: vi.fn(),
  isLbugReady: vi.fn(() => false),
  isWriteQuery: vi.fn((query: string) => /DELETE|CREATE|SET|MERGE|DROP|ALTER/i.test(query)),
}));

vi.mock('../../src/core/neo4j/config.js', () => ({
  isNeo4jBackendEnabled: vi.fn(() => true),
}));

vi.mock('../../src/core/neo4j/read-adapter.js', () => ({
  executeReadCypher: vi.fn(async () => []),
  findSymbolContext: vi.fn(async () => [
    {
      id: 'Function:handler',
      name: 'handler',
      type: 'Function',
      filePath: 'src/handler.ts',
      incoming: [{ type: 'CALLS', source: 'Function:caller', sourceName: 'caller' }],
      outgoing: [{ type: 'CALLS', target: 'Function:callee', targetName: 'callee' }],
    },
  ]),
  findImpact: vi.fn(async () => [
    {
      id: 'Function:caller',
      name: 'caller',
      type: 'Function',
      filePath: 'src/caller.ts',
      depth: 1,
    },
  ]),
}));

const repo = {
  id: 'repo-a',
  name: 'Repo A',
  repoPath: '/repo/a',
  storagePath: '/repo/a/.gitnexus',
  lbugPath: '/repo/a/.gitnexus/lbug',
  indexedAt: '2026-05-30',
  lastCommit: 'abc',
};

describe('LocalBackend context and impact with Neo4j backend', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads symbol context from Neo4j without initializing LadybugDB', async () => {
    const backend = new LocalBackend();

    const result = await (backend as any).context(repo, { name: 'handler' });

    expect(findSymbolContext).toHaveBeenCalledWith('Repo A', 'handler', 10, {
      filePath: undefined,
      kind: undefined,
    });
    expect(initLbug).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'found',
      symbol: {
        uid: 'Function:handler',
        name: 'handler',
        kind: 'Function',
        filePath: 'src/handler.ts',
      },
    });
    expect(result.incoming.calls[0].name).toBe('caller');
    expect(result.outgoing.calls[0].name).toBe('callee');
  });

  it('loads impact from Neo4j without initializing LadybugDB', async () => {
    const backend = new LocalBackend();

    const result = await (backend as any).impact(repo, {
      target: 'handler',
      direction: 'upstream',
      maxDepth: 2,
    });

    expect(findImpact).toHaveBeenCalledWith('Repo A', 'handler', 'upstream', 2, {
      filePath: undefined,
      kind: undefined,
    });
    expect(initLbug).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      target: { name: 'handler' },
      direction: 'upstream',
      impactedCount: 1,
      risk: 'LOW',
      byDepth: {
        '1': [
          {
            uid: 'Function:caller',
            name: 'caller',
            kind: 'Function',
            filePath: 'src/caller.ts',
          },
        ],
      },
    });
  });

  it('passes file_path and kind hints to Neo4j context lookup', async () => {
    const backend = new LocalBackend();

    await (backend as any).context(repo, {
      name: 'submitCheck',
      file_path: 'RefundMoneyServiceImpl.java',
      kind: 'Method',
    });

    expect(findSymbolContext).toHaveBeenCalledWith('Repo A', 'submitCheck', 10, {
      filePath: 'RefundMoneyServiceImpl.java',
      kind: 'Method',
    });
  });

  it('passes file_path and kind hints to Neo4j impact lookup', async () => {
    const backend = new LocalBackend();

    await (backend as any).impact(repo, {
      target: 'submitCheck',
      direction: 'upstream',
      file_path: 'RefundMoneyServiceImpl.java',
      kind: 'Method',
    });

    expect(findImpact).toHaveBeenCalledWith('Repo A', 'submitCheck', 'upstream', 3, {
      filePath: 'RefundMoneyServiceImpl.java',
      kind: 'Method',
    });
  });

  it('loads API route map from Neo4j without initializing LadybugDB', async () => {
    vi.mocked(executeReadCypher)
      .mockResolvedValueOnce([
        {
          routeId: 'Route:/api/users',
          routeName: '/api/users',
          handlerFile: 'src/api/users.ts',
          responseKeys: ['data'],
          errorKeys: ['error'],
          middleware: ['withAuth'],
          consumerName: 'useUsers',
          consumerFile: 'src/hooks/use-users.ts',
          fetchReason: 'fetch-url-match|keys:data|fetches:1',
        },
      ])
      .mockResolvedValueOnce([{ sourceId: 'Route:/api/users', name: 'UserListFlow' }]);

    const backend = new LocalBackend();

    const result = await (backend as any).routeMap(repo, { route: '/api/users' });

    expect(initLbug).not.toHaveBeenCalled();
    expect(executeParameterized).not.toHaveBeenCalled();
    expect(executeReadCypher).toHaveBeenCalledTimes(2);
    expect(executeReadCypher).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('MATCH (n:Route {repoId: $repoId})'),
      { repoId: 'Repo A', route: '/api/users' },
    );
    expect(executeReadCypher).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('MATCH (source {repoId: $repoId})-[r:ENTRY_POINT_OF]->'),
      { repoId: 'Repo A', nodeIds: ['Route:/api/users'] },
    );
    expect(result).toMatchObject({
      total: 1,
      routes: [
        {
          route: '/api/users',
          handler: 'src/api/users.ts',
          middleware: ['withAuth'],
          flows: ['UserListFlow'],
          consumers: [
            {
              name: 'useUsers',
              filePath: 'src/hooks/use-users.ts',
              accessedKeys: ['data'],
            },
          ],
        },
      ],
    });
  });

  it('loads API shape check from Neo4j without initializing LadybugDB', async () => {
    vi.mocked(executeReadCypher).mockResolvedValueOnce([
      {
        routeId: 'Route:/api/users',
        routeName: '/api/users',
        handlerFile: 'src/api/users.ts',
        responseKeys: ['data'],
        errorKeys: ['error'],
        middleware: [],
        consumerName: 'useUsers',
        consumerFile: 'src/hooks/use-users.ts',
        fetchReason: 'fetch-url-match|keys:data,missing|fetches:1',
      },
    ]);

    const backend = new LocalBackend();

    const result = await (backend as any).shapeCheck(repo, { route: '/api/users' });

    expect(initLbug).not.toHaveBeenCalled();
    expect(executeParameterized).not.toHaveBeenCalled();
    expect(executeReadCypher).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      total: 1,
      mismatches: 1,
      routes: [
        {
          route: '/api/users',
          status: 'MISMATCH',
          consumers: [
            {
              name: 'useUsers',
              filePath: 'src/hooks/use-users.ts',
              accessedKeys: ['data', 'missing'],
              mismatched: ['missing'],
            },
          ],
        },
      ],
    });
  });

  it('loads API impact from Neo4j without initializing LadybugDB', async () => {
    vi.mocked(executeReadCypher)
      .mockResolvedValueOnce([
        {
          routeId: 'Route:/api/users',
          routeName: '/api/users',
          handlerFile: 'src/api/users.ts',
          responseKeys: ['data'],
          errorKeys: ['error'],
          middleware: ['withAuth'],
          consumerName: 'useUsers',
          consumerFile: 'src/hooks/use-users.ts',
          fetchReason: 'fetch-url-match|keys:data|fetches:1',
        },
      ])
      .mockResolvedValueOnce([{ sourceId: 'Route:/api/users', name: 'UserListFlow' }]);

    const backend = new LocalBackend();

    const result = await (backend as any).apiImpact(repo, { route: '/api/users' });

    expect(initLbug).not.toHaveBeenCalled();
    expect(executeParameterized).not.toHaveBeenCalled();
    expect(executeReadCypher).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      route: '/api/users',
      handler: 'src/api/users.ts',
      responseShape: {
        success: ['data'],
        error: ['error'],
      },
      middleware: ['withAuth'],
      consumers: [
        {
          name: 'useUsers',
          file: 'src/hooks/use-users.ts',
          accesses: ['data'],
        },
      ],
      executionFlows: ['UserListFlow'],
      impactSummary: {
        directConsumers: 1,
        affectedFlows: 1,
        riskLevel: 'LOW',
      },
    });
  });
});
