import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

const txRun = vi.fn();
const executeWrite = vi.fn(async (work: any) => work({ run: txRun }));
const withNeo4jSession = vi.fn(async (work: any) => work({ executeWrite }));
const clearRepoIndex = vi.fn();
const upsertNodes = vi.fn();
const upsertRelations = vi.fn();

vi.mock('../../src/core/neo4j/driver.js', () => ({
  withNeo4jSession,
}));

vi.mock('../../src/core/neo4j/schema.js', () => ({
  getNeo4jSchemaStatements: vi.fn(() => ({
    all: ['CREATE CONSTRAINT one', 'CREATE INDEX two'],
  })),
}));

vi.mock('../../src/core/neo4j/write-adapter.js', () => ({
  clearRepoIndex,
  upsertNodes,
  upsertRelations,
}));

describe('Neo4j graph loader', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('applies schema, clears repo data, and writes graph nodes and relationships', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'File:src/a.ts',
      label: 'File',
      properties: { name: 'a.ts', filePath: 'src/a.ts' },
    });
    graph.addNode({
      id: 'Function:a',
      label: 'Function',
      properties: { name: 'a', filePath: 'src/a.ts', startLine: 1, endLine: 3 },
    });
    graph.addRelationship({
      id: 'rel:a',
      sourceId: 'File:src/a.ts',
      targetId: 'Function:a',
      type: 'CONTAINS',
      confidence: 1,
      reason: 'test',
    });

    const { loadGraphToNeo4j } = await import('../../src/core/neo4j/graph-loader.js');
    const stats = await loadGraphToNeo4j('repo-a', graph);

    expect(txRun).toHaveBeenCalledWith('CREATE CONSTRAINT one');
    expect(txRun).toHaveBeenCalledWith('CREATE INDEX two');
    expect(clearRepoIndex).toHaveBeenCalledWith('repo-a');
    expect(upsertNodes).toHaveBeenCalledWith('repo-a', [
      {
        label: 'File',
        properties: { id: 'File:src/a.ts', name: 'a.ts', filePath: 'src/a.ts' },
      },
      {
        label: 'Function',
        properties: {
          id: 'Function:a',
          name: 'a',
          filePath: 'src/a.ts',
          startLine: 1,
          endLine: 3,
        },
      },
    ]);
    expect(upsertRelations).toHaveBeenCalledWith('repo-a', [
      {
        type: 'CONTAINS',
        fromId: 'File:src/a.ts',
        toId: 'Function:a',
        properties: { type: 'CONTAINS', confidence: 1, reason: 'test', step: undefined },
      },
    ]);
    expect(stats).toEqual({ nodes: 2, edges: 1 });
  });
});
