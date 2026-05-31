import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { executeReadCypher } from '../../src/core/neo4j/read-adapter.js';
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
  executeReadCypher: vi.fn(async () => [{ name: 'handler' }]),
}));

describe('LocalBackend cypher with Neo4j backend', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('executes read cypher through Neo4j without initializing LadybugDB', async () => {
    const backend = new LocalBackend();

    const result = await (backend as any).cypher(
      {
        id: 'repo-a',
        name: 'Repo A',
        repoPath: '/repo/a',
        storagePath: '/repo/a/.gitnexus',
        lbugPath: '/repo/a/.gitnexus/lbug',
        indexedAt: '2026-05-30',
        lastCommit: 'abc',
      },
      { query: 'MATCH (n) RETURN n.name AS name' },
    );

    expect(executeReadCypher).toHaveBeenCalledWith('MATCH (n) RETURN n.name AS name');
    expect(initLbug).not.toHaveBeenCalled();
    expect(result).toEqual([{ name: 'handler' }]);
  });
});
