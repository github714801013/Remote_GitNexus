import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { findImpact, findSymbolContext } from '../../src/core/neo4j/read-adapter.js';
import { initLbug } from '../../src/core/lbug/pool-adapter.js';

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

    expect(findSymbolContext).toHaveBeenCalledWith('Repo A', 'handler', 10);
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

    expect(findImpact).toHaveBeenCalledWith('Repo A', 'handler', 'upstream', 2);
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
});
