import {
  EMBEDDING_TABLE_NAME,
  NODE_TABLES,
  REL_TYPES,
  type NodeTableName,
  type RelType,
} from 'gitnexus-shared';
import neo4j from 'neo4j-driver';
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
const CODE_NODE_LABEL = 'CodeNode';
const WRITE_BATCH_SIZE = 500;
const CLEAR_REPO_LABELS = [...NODE_TABLES, CODE_NODE_LABEL, EMBEDDING_TABLE_NAME] as const;

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

const chunksOf = <T>(values: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

const asNumber = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (value && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value ?? 0);
};

export const clearRepoIndex = async (repoId: string): Promise<void> => {
  await withNeo4jSession(async (session) => {
    for (const label of CLEAR_REPO_LABELS) {
      let deleted = WRITE_BATCH_SIZE;
      while (deleted === WRITE_BATCH_SIZE) {
        deleted = await session.executeWrite(async (tx) => {
          const result = await tx.run(
            `MATCH (n:\`${label}\` {repoId: $repoId}) WITH n LIMIT $batchSize DETACH DELETE n RETURN count(n) AS deleted`,
            { repoId, batchSize: neo4j.int(WRITE_BATCH_SIZE) },
          );
          return asNumber(result.records[0]?.get('deleted'));
        });
      }
    }
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
    for (const [label, bucket] of grouped) {
      const safeLabel = checkedNodeLabel(label);
      for (const chunk of chunksOf(bucket, WRITE_BATCH_SIZE)) {
        await session.executeWrite(async (tx) => {
          await tx.run(
            `UNWIND $nodes AS row MERGE (n:\`${CODE_NODE_LABEL}\` {repoId: $repoId, id: row.id}) SET n:\`${safeLabel}\` SET n += row.props`,
            {
              repoId,
              nodes: chunk.map((node) => ({
                id: String(node.properties.id),
                props: {
                  ...node.properties,
                  id: String(node.properties.id),
                  repoId,
                },
              })),
            },
          );
        });
      }
    }
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
    for (const [type, bucket] of grouped) {
      const safeType = checkedRelationshipType(type);
      for (const chunk of chunksOf(bucket, WRITE_BATCH_SIZE)) {
        await session.executeWrite(async (tx) => {
          await tx.run(
            `UNWIND $relationships AS row MATCH (from:\`${CODE_NODE_LABEL}\` {repoId: $repoId, id: row.fromId}) MATCH (to:\`${CODE_NODE_LABEL}\` {repoId: $repoId, id: row.toId}) MERGE (from)-[r:\`${safeType}\`]->(to) SET r += row.props`,
            {
              repoId,
              relationships: chunk.map((relationship) => ({
                fromId: relationship.fromId,
                toId: relationship.toId,
                props: {
                  type,
                  ...(relationship.properties ?? {}),
                },
              })),
            },
          );
        });
      }
    }
  });
};
