import { afterEach, describe, expect, it, vi } from 'vitest';

const txRun = vi.fn();
const executeWrite = vi.fn(async (work: any) => work({ run: txRun }));
const withNeo4jSession = vi.fn(async (work: any) => work({ executeWrite }));

vi.mock('../../src/core/neo4j/driver.js', () => ({
  withNeo4jSession,
}));

describe('Neo4j write adapter', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('clears all indexed data for one repoId', async () => {
    const { clearRepoIndex } = await import('../../src/core/neo4j/write-adapter.js');

    await clearRepoIndex('repo-a');

    expect(txRun).toHaveBeenCalledWith('MATCH (n {repoId: $repoId}) DETACH DELETE n', {
      repoId: 'repo-a',
    });
  });

  it('batch upserts nodes grouped by label', async () => {
    const { upsertNodes } = await import('../../src/core/neo4j/write-adapter.js');

    await upsertNodes('repo-a', [
      { label: 'Function', properties: { id: 'Function:one', name: 'one', filePath: 'a.ts' } },
      { label: 'Function', properties: { id: 'Function:two', name: 'two', filePath: 'b.ts' } },
      { label: 'File', properties: { id: 'File:a.ts', name: 'a.ts', filePath: 'a.ts' } },
    ]);

    expect(txRun).toHaveBeenCalledWith(
      'UNWIND $nodes AS row MERGE (n:`Function` {repoId: $repoId, id: row.id}) SET n += row.props',
      {
        repoId: 'repo-a',
        nodes: [
          {
            id: 'Function:one',
            props: { id: 'Function:one', repoId: 'repo-a', name: 'one', filePath: 'a.ts' },
          },
          {
            id: 'Function:two',
            props: { id: 'Function:two', repoId: 'repo-a', name: 'two', filePath: 'b.ts' },
          },
        ],
      },
    );
    expect(txRun).toHaveBeenCalledWith(
      'UNWIND $nodes AS row MERGE (n:`File` {repoId: $repoId, id: row.id}) SET n += row.props',
      {
        repoId: 'repo-a',
        nodes: [
          {
            id: 'File:a.ts',
            props: { id: 'File:a.ts', repoId: 'repo-a', name: 'a.ts', filePath: 'a.ts' },
          },
        ],
      },
    );
  });

  it('rejects unknown node labels', async () => {
    const { upsertNodes } = await import('../../src/core/neo4j/write-adapter.js');

    await expect(
      upsertNodes('repo-a', [{ label: 'Bad`Label', properties: { id: 'x' } }]),
    ).rejects.toThrow('Unsupported Neo4j node label: Bad`Label');
  });

  it('batch upserts relationships grouped by type', async () => {
    const { upsertRelations } = await import('../../src/core/neo4j/write-adapter.js');

    await upsertRelations('repo-a', [
      {
        type: 'CALLS',
        fromId: 'Function:caller',
        toId: 'Function:callee',
        properties: { confidence: 0.9, reason: 'test' },
      },
    ]);

    expect(txRun).toHaveBeenCalledWith(
      'UNWIND $relationships AS row MATCH (from {repoId: $repoId, id: row.fromId}) MATCH (to {repoId: $repoId, id: row.toId}) MERGE (from)-[r:`CALLS`]->(to) SET r += row.props',
      {
        repoId: 'repo-a',
        relationships: [
          {
            fromId: 'Function:caller',
            toId: 'Function:callee',
            props: { type: 'CALLS', confidence: 0.9, reason: 'test' },
          },
        ],
      },
    );
  });

  it('rejects unknown relationship types', async () => {
    const { upsertRelations } = await import('../../src/core/neo4j/write-adapter.js');

    await expect(
      upsertRelations('repo-a', [
        { type: 'DROP', fromId: 'Function:a', toId: 'Function:b', properties: {} },
      ]),
    ).rejects.toThrow('Unsupported Neo4j relationship type: DROP');
  });
});
