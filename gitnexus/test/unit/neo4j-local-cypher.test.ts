import { afterEach, describe, expect, it, vi } from 'vitest';

const txRun = vi.fn();
const executeRead = vi.fn(async (work: any) => work({ run: txRun }));
const withNeo4jSession = vi.fn(async (work: any) => work({ executeRead }));

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  isWriteQuery: vi.fn((query: string) => /DELETE|CREATE|SET|MERGE|DROP|ALTER/i.test(query)),
}));

vi.mock('../../src/core/neo4j/driver.js', () => ({
  withNeo4jSession,
}));

describe('Neo4j repo-scoped cypher guard', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects repo-scoped Neo4j cypher that does not explicitly filter by repoId', async () => {
    const { executeRepoScopedReadCypher } = await import('../../src/core/neo4j/read-adapter.js');

    await expect(
      executeRepoScopedReadCypher('MATCH (n) RETURN n.name AS name', 'Repo A'),
    ).rejects.toThrow('repoId');
    expect(txRun).not.toHaveBeenCalled();
  });

  it('passes repoId params for repo-scoped Neo4j cypher', async () => {
    txRun.mockResolvedValueOnce({
      records: [
        {
          keys: ['name'],
          get: (key: string) => ({ name: 'handler' })[key],
        },
      ],
    });
    const { executeRepoScopedReadCypher } = await import('../../src/core/neo4j/read-adapter.js');

    const result = await executeRepoScopedReadCypher(
      'MATCH (n {repoId: $repoId}) RETURN n.name AS name',
      'Repo A',
    );

    expect(txRun).toHaveBeenCalledWith('MATCH (n {repoId: $repoId}) RETURN n.name AS name', {
      repoId: 'Repo A',
    });
    expect(result).toEqual([{ name: 'handler' }]);
  });

  it('keeps global Neo4j cypher available when no repo scope is requested', async () => {
    txRun.mockResolvedValueOnce({
      records: [
        {
          keys: ['name'],
          get: (key: string) => ({ name: 'handler' })[key],
        },
      ],
    });
    const { executeRepoScopedReadCypher } = await import('../../src/core/neo4j/read-adapter.js');

    const result = await executeRepoScopedReadCypher('MATCH (n) RETURN n.name AS name');

    expect(txRun).toHaveBeenCalledWith('MATCH (n) RETURN n.name AS name', {});
    expect(result).toEqual([{ name: 'handler' }]);
  });
});
