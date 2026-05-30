import { NODE_TABLES, REL_TYPES, type NodeTableName, type RelType } from 'gitnexus-shared';
import { withNeo4jSession } from './driver.js';

export interface Neo4jNodeInput {
  label: string;
  properties: Record<string, any>;
}

export interface Neo4jRelationshipInput {
  type: string;
  fromId: string;
  toId: string;
  properties?: Record<string, any>;
}

const NODE_LABELS = new Set<string>(NODE_TABLES);
const RELATIONSHIP_TYPES = new Set<string>(REL_TYPES);

const checkedNodeLabel = (label: string): NodeTableName => {
  if (!NODE_LABELS.has(label)) {
    throw new Error(`Unsupported Neo4j node label: ${label}`);
  }
  return label as NodeTableName;
};

const checkedRelationshipType = (type: string): RelType => {
  if (!RELATIONSHIP_TYPES.has(type)) {
    throw new Error(`Unsupported Neo4j relationship type: ${type}`);
  }
  return type as RelType;
};

const groupBy = <T>(values: T[], keyOf: (value: T) => string): Map<string, T[]> => {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(value);
    } else {
      grouped.set(key, [value]);
    }
  }
  return grouped;
};

export const clearRepoIndex = async (repoId: string): Promise<void> => {
  await withNeo4jSession(async (session) => {
    await session.executeWrite(async (tx) => {
      await tx.run('MATCH (n {repoId: $repoId}) DETACH DELETE n', { repoId });
    });
  });
};

export const upsertNodes = async (repoId: string, nodes: Neo4jNodeInput[]): Promise<void> => {
  if (nodes.length === 0) return;

  for (const node of nodes) {
    checkedNodeLabel(node.label);
    if (!node.properties.id) {
      throw new Error(`Neo4j node ${node.label} is missing required id`);
    }
  }

  const grouped = groupBy(nodes, (node) => node.label);
  await withNeo4jSession(async (session) => {
    await session.executeWrite(async (tx) => {
      for (const [label, bucket] of grouped) {
        const safeLabel = checkedNodeLabel(label);
        await tx.run(
          `UNWIND $nodes AS row MERGE (n:\`${safeLabel}\` {repoId: $repoId, id: row.id}) SET n += row.props`,
          {
            repoId,
            nodes: bucket.map((node) => ({
              id: String(node.properties.id),
              props: {
                ...node.properties,
                id: String(node.properties.id),
                repoId,
              },
            })),
          },
        );
      }
    });
  });
};

export const upsertRelations = async (
  repoId: string,
  relationships: Neo4jRelationshipInput[],
): Promise<void> => {
  if (relationships.length === 0) return;

  for (const relationship of relationships) {
    checkedRelationshipType(relationship.type);
    if (!relationship.fromId || !relationship.toId) {
      throw new Error(`Neo4j relationship ${relationship.type} is missing endpoint ids`);
    }
  }

  const grouped = groupBy(relationships, (relationship) => relationship.type);
  await withNeo4jSession(async (session) => {
    await session.executeWrite(async (tx) => {
      for (const [type, bucket] of grouped) {
        const safeType = checkedRelationshipType(type);
        await tx.run(
          `UNWIND $relationships AS row MATCH (from {repoId: $repoId, id: row.fromId}) MATCH (to {repoId: $repoId, id: row.toId}) MERGE (from)-[r:\`${safeType}\`]->(to) SET r += row.props`,
          {
            repoId,
            relationships: bucket.map((relationship) => ({
              fromId: relationship.fromId,
              toId: relationship.toId,
              props: {
                type,
                ...(relationship.properties ?? {}),
              },
            })),
          },
        );
      }
    });
  });
};
