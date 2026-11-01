import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import {
  executeReadCypher,
  findSymbolContext,
} from '../../src/core/neo4j/read-adapter.js';

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
  findSymbolContext: vi.fn(async () => []),
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

describe('Neo4j context', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(executeReadCypher).mockReset();
    vi.mocked(executeReadCypher).mockResolvedValue([]);
    vi.mocked(findSymbolContext).mockReset();
    vi.mocked(findSymbolContext).mockResolvedValue([]);
  });

  it('fills processes, routes and chain from Neo4j', async () => {
    vi.mocked(findSymbolContext).mockResolvedValue([
      {
        id: 'Function:handler',
        name: 'handler',
        type: 'Function',
        filePath: 'src/h.ts',
        startLine: 1,
        endLine: 5,
        incoming: [],
        outgoing: [],
      },
    ] as any);
    vi.mocked(executeReadCypher).mockImplementation(async (cypher: string) => {
      if (cypher.includes('STEP_IN_PROCESS')) {
        return [
          {
            pid: 'Process:p1',
            label: 'Flow',
            step: 2,
            stepCount: 5,
            entryPointId: 'Function:handler',
          },
        ];
      }
      if (cypher.includes('HANDLES_ROUTE')) {
        return [{ url: '/api/x', method: 'GET' }];
      }
      if (cypher.includes('caller:CodeNode')) {
        return [
          { uid: 'Function:caller', name: 'caller', filePath: 'src/a.ts', kind: 'Function', isTest: 0 },
        ];
      }
      if (cypher.includes('target:CodeNode')) {
        return [
          { uid: 'Function:callee', name: 'callee', filePath: 'src/c.ts', kind: 'Function', isTest: 0 },
        ];
      }
      return [];
    });
    const backend = new LocalBackend();

    const result = await (backend as any)._contextImpl(repo, {
      name: 'handler',
      chain_depth: 1,
    });

    expect(executeParameterized).not.toHaveBeenCalled();
    expect(result.processes).toEqual([
      { id: 'Process:p1', name: 'Flow', step_index: 2, step_count: 5 },
    ]);
    expect(result.is_entry_point).toBe(true);
    expect(result.routes).toEqual([{ url: '/api/x', method: 'GET' }]);
    expect(result.chain).toEqual([
      {
        depth: 1,
        upstream: [
          { uid: 'Function:caller', name: 'caller', filePath: 'src/a.ts', kind: 'Function' },
        ],
        downstream: [
          { uid: 'Function:callee', name: 'callee', filePath: 'src/c.ts', kind: 'Function' },
        ],
      },
    ]);

    const chainCyphers = vi
      .mocked(executeReadCypher)
      .mock.calls.map(([cypher]) => cypher as string)
      .filter((cypher) => cypher.includes('CALLS'));
    expect(chainCyphers).toHaveLength(2);
    expect(chainCyphers.some((cypher) => cypher.includes('labels(caller)[0]'))).toBe(true);
    expect(chainCyphers.some((cypher) => cypher.includes('labels(target)[0]'))).toBe(true);
  });
});
