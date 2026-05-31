import { afterEach, describe, expect, it, vi } from 'vitest';

const txRun = vi.fn();
const executeRead = vi.fn(async (work: any) => work({ run: txRun }));
const withNeo4jSession = vi.fn(async (work: any) => work({ executeRead }));

vi.mock('../../src/core/neo4j/driver.js', () => ({
  withNeo4jSession,
}));

const record = (values: Record<string, any>) => ({
  keys: Object.keys(values),
  get: (key: string) => values[key],
});

describe('Neo4j read adapter', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('executes read cypher and maps records to plain objects', async () => {
    txRun.mockResolvedValueOnce({
      records: [record({ name: 'handler', filePath: 'src/a.ts' })],
    });
    const { executeReadCypher } = await import('../../src/core/neo4j/read-adapter.js');

    const rows = await executeReadCypher('MATCH (n) RETURN n.name AS name', { limit: 1 });

    expect(txRun).toHaveBeenCalledWith('MATCH (n) RETURN n.name AS name', { limit: 1 });
    expect(rows).toEqual([{ name: 'handler', filePath: 'src/a.ts' }]);
  });

  it('rejects write cypher', async () => {
    const { executeReadCypher } = await import('../../src/core/neo4j/read-adapter.js');

    await expect(executeReadCypher('MATCH (n) DETACH DELETE n')).rejects.toThrow(
      'Write operations are not allowed in Neo4j read queries.',
    );
    expect(txRun).not.toHaveBeenCalled();
  });

  it('finds symbol context by repoId and target', async () => {
    txRun.mockResolvedValueOnce({ records: [record({ id: 'Function:a', name: 'a' })] });
    const { findSymbolContext } = await import('../../src/core/neo4j/read-adapter.js');

    await findSymbolContext('repo-a', 'handler', 5);

    expect(txRun).toHaveBeenCalledWith(
      expect.stringContaining('WHERE n.id = $target OR n.name = $target'),
      expect.objectContaining({
        repoId: 'repo-a',
        target: 'handler',
      }),
    );
    const params = txRun.mock.calls[0][1];
    expect(params.limit.toNumber()).toBe(5);
  });

  it('finds upstream impact with bounded depth', async () => {
    txRun.mockResolvedValueOnce({ records: [record({ id: 'Function:caller', depth: 1 })] });
    const { findImpact } = await import('../../src/core/neo4j/read-adapter.js');

    await findImpact('repo-a', 'Function:callee', 'upstream', 2);

    expect(txRun).toHaveBeenCalledWith(expect.stringContaining('[*1..2]->(target'), {
      repoId: 'repo-a',
      target: 'Function:callee',
    });
  });

  it('finds downstream impact with bounded depth', async () => {
    txRun.mockResolvedValueOnce({ records: [record({ id: 'Function:callee', depth: 1 })] });
    const { findImpact } = await import('../../src/core/neo4j/read-adapter.js');

    await findImpact('repo-a', 'Function:caller', 'downstream', 3);

    expect(txRun).toHaveBeenCalledWith(expect.stringContaining('(source)-[*1..3]->'), {
      repoId: 'repo-a',
      target: 'Function:caller',
    });
  });
});
