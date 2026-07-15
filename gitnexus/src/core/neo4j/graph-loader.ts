import type { GraphNode } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';
import { getNeo4jSchemaStatements } from './schema.js';
import { withNeo4jSession } from './driver.js';
import { clearRepoIndex, upsertNodes, upsertRelations } from './write-adapter.js';

export interface Neo4jGraphLoadStats {
  nodes: number;
  edges: number;
}

const toNodeProperties = (node: GraphNode): Record<string, any> => {
  return {
    id: node.id,
    ...node.properties,
  };
};

export const applyNeo4jSchema = async (): Promise<void> => {
  const statements = getNeo4jSchemaStatements().all;
  await withNeo4jSession(async (session) => {
    await session.executeWrite(async (tx) => {
      for (const statement of statements) {
        await tx.run(statement);
      }
    });
  });
};

export const countRepoGraphNodes = async (repoId: string): Promise<number> => {
  return await withNeo4jSession(async (session) => {
    return await session.executeRead(async (tx) => {
      const result = await tx.run('MATCH (n {repoId: $repoId}) RETURN count(n) AS cnt', {
        repoId,
      });
      const value = result.records?.[0]?.get('cnt');
      return typeof value?.toNumber === 'function' ? value.toNumber() : Number(value ?? 0);
    });
  });
};

const relinkPreservedEmbeddings = async (repoId: string): Promise<void> => {
  await withNeo4jSession(async (session) => {
    await session.executeWrite(async (tx) => {
      await tx.run(
        `MATCH (e:CodeEmbedding {repoId: $repoId}) MATCH (n:CodeNode {repoId: $repoId, id: e.nodeId}) MERGE (e)-[:EMBEDS]->(n)`,
        { repoId },
      );
      await tx.run(
        `MATCH (e:CodeEmbedding {repoId: $repoId}) WHERE NOT (e)-[:EMBEDS]->() DETACH DELETE e`,
        { repoId },
      );
    });
  });
};

export const loadGraphToNeo4j = async (
  repoId: string,
  graph: KnowledgeGraph,
  options: { preserveEmbeddings?: boolean } = {},
): Promise<Neo4jGraphLoadStats> => {
  await applyNeo4jSchema();
  if (options.preserveEmbeddings) {
    await clearRepoIndex(repoId, options);
  } else {
    await clearRepoIndex(repoId);
  }

  const nodes = Array.from(graph.iterNodes()).map((node) => ({
    label: node.label,
    properties: toNodeProperties(node),
  }));
  const relationships = Array.from(graph.iterRelationships()).map((relationship) => ({
    type: relationship.type,
    fromId: relationship.sourceId,
    toId: relationship.targetId,
    properties: {
      type: relationship.type,
      confidence: relationship.confidence,
      reason: relationship.reason,
      step: relationship.step,
    },
  }));

  await upsertNodes(repoId, nodes);
  await upsertRelations(repoId, relationships);
  if (options.preserveEmbeddings) await relinkPreservedEmbeddings(repoId);

  return {
    nodes: nodes.length,
    edges: relationships.length,
  };
};
