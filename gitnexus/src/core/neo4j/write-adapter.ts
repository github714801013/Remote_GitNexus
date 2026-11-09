import {
  EMBEDDING_TABLE_NAME,
  NODE_TABLES,
  REL_TYPES,
  type NodeTableName,
  type RelType,
} from 'gitnexus-shared';
import neo4j from 'neo4j-driver';
import { withNeo4jSession } from './driver.js';
import { logger } from '../logger.js';

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
const RELATIONSHIP_WRITE_TIMEOUT_MS = 600_000;
const CLEAR_REPO_LABELS = [...NODE_TABLES, CODE_NODE_LABEL, EMBEDDING_TABLE_NAME] as const;

export interface Neo4jWriteProgress {
  readonly operation: 'clear' | 'nodes' | 'relationships';
  readonly completedBatches: number;
  readonly totalBatches?: number;
  readonly completedItems: number;
  readonly totalItems?: number;
  readonly label?: string;
  readonly relationshipType?: string;
}

export type Neo4jWriteProgressCallback = (progress: Neo4jWriteProgress) => void;

export interface ClearRepoIndexOptions {
  /** Keep existing vectors so unchanged nodes can be re-linked after a graph rebuild. */
  preserveEmbeddings?: boolean;
  /** Receives progress only after each successful delete transaction. */
  onProgress?: Neo4jWriteProgressCallback;
}

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

export const clearRepoIndex = async (
  repoId: string,
  options: ClearRepoIndexOptions = {},
): Promise<void> => {
  const labels = options.preserveEmbeddings
    ? CLEAR_REPO_LABELS.filter((label) => label !== EMBEDDING_TABLE_NAME)
    : CLEAR_REPO_LABELS;
  let completedBatches = 0;
  let completedItems = 0;
  await withNeo4jSession(async (session) => {
    for (const label of labels) {
      let deleted = WRITE_BATCH_SIZE;
      while (deleted === WRITE_BATCH_SIZE) {
        deleted = await session.executeWrite(async (tx) => {
          const result = await tx.run(
            `MATCH (n:\`${label}\` {repoId: $repoId}) WITH n LIMIT $batchSize DETACH DELETE n RETURN count(n) AS deleted`,
            { repoId, batchSize: neo4j.int(WRITE_BATCH_SIZE) },
          );
          return asNumber(result.records[0]?.get('deleted'));
        });
        if (deleted === 0) continue;
        completedBatches++;
        completedItems += deleted;
        options.onProgress?.({
          operation: 'clear',
          completedBatches,
          completedItems,
          label,
        });
      }
    }
  });
};

export const upsertNodes = async (
  repoId: string,
  nodes: Neo4jNodeInput[],
  onProgress?: Neo4jWriteProgressCallback,
): Promise<void> => {
  if (nodes.length === 0) return;

  for (const node of nodes) {
    checkedNodeLabel(node.label);
    if (!node.properties.id) {
      throw new Error(`Neo4j node ${node.label} is missing required id`);
    }
  }

  const grouped = groupBy(nodes, (node) => node.label);
  const totalBatches = [...grouped.values()].reduce(
    (total, bucket) => total + Math.ceil(bucket.length / WRITE_BATCH_SIZE),
    0,
  );
  let completedBatches = 0;
  let completedItems = 0;
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
        completedBatches++;
        completedItems += chunk.length;
        onProgress?.({
          operation: 'nodes',
          completedBatches,
          totalBatches,
          completedItems,
          totalItems: nodes.length,
          label,
        });
      }
    }
  });
};

export const upsertRelations = async (
  repoId: string,
  relationships: Neo4jRelationshipInput[],
  onProgress?: Neo4jWriteProgressCallback,
): Promise<void> => {
  if (relationships.length === 0) return;

  for (const relationship of relationships) {
    checkedRelationshipType(relationship.type);
    if (!relationship.fromId || !relationship.toId) {
      throw new Error(`Neo4j relationship ${relationship.type} is missing endpoint ids`);
    }
  }

  const grouped = groupBy(relationships, (relationship) => relationship.type);
  const totalBatches = [...grouped.values()].reduce(
    (total, bucket) => total + Math.ceil(bucket.length / WRITE_BATCH_SIZE),
    0,
  );
  let completedBatches = 0;
  let completedItems = 0;
  const relationshipWriteStartedAt = performance.now();
  await withNeo4jSession(async (session) => {
    for (const [type, bucket] of grouped) {
      const safeType = checkedRelationshipType(type);
      for (const chunk of chunksOf(bucket, WRITE_BATCH_SIZE)) {
        const batchIndex = completedBatches + 1;
        const batchStartedAt = performance.now();
        let transactionAttempt = 0;
        const batchContext = {
          operation: 'neo4j.relationships',
          relationshipType: type,
          batchIndex,
          totalBatches,
          batchSize: chunk.length,
          totalRelationships: relationships.length,
          completedRelationships: completedItems,
        };
        logger.info(batchContext, 'Neo4j relationship batch started');
        try {
          await session.executeWrite(async (tx) => {
            transactionAttempt++;
            const transactionStartedAt = performance.now();
            logger.info(
              { ...batchContext, transactionAttempt },
              'Neo4j relationship transaction attempt started',
            );
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
            logger.info(
              {
                ...batchContext,
                transactionAttempt,
                txRunElapsedMs: Math.round(performance.now() - transactionStartedAt),
              },
              'Neo4j relationship tx.run returned',
            );
          }, { timeout: RELATIONSHIP_WRITE_TIMEOUT_MS });
        } catch (err) {
          logger.error(
            {
              ...batchContext,
              transactionAttempt,
              batchElapsedMs: Math.round(performance.now() - batchStartedAt),
              cumulativeElapsedMs: Math.round(performance.now() - relationshipWriteStartedAt),
              errorName: err instanceof Error ? err.name : typeof err,
              errorCode:
                err && typeof err === 'object' && 'code' in err
                  ? String((err as { code?: unknown }).code ?? '')
                  : undefined,
            },
            'Neo4j relationship batch failed',
          );
          throw err;
        }
        completedBatches++;
        completedItems += chunk.length;
        logger.info(
          {
            ...batchContext,
            transactionAttempt,
            completedRelationships: completedItems,
            batchElapsedMs: Math.round(performance.now() - batchStartedAt),
            cumulativeElapsedMs: Math.round(performance.now() - relationshipWriteStartedAt),
          },
          'Neo4j relationship batch committed',
        );
        onProgress?.({
          operation: 'relationships',
          completedBatches,
          totalBatches,
          completedItems,
          totalItems: relationships.length,
          relationshipType: type,
        });
      }
    }
  });
};
