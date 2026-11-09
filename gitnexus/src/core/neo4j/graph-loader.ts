import type { GraphNode } from 'gitnexus-shared';
import neo4j from 'neo4j-driver';
import type { KnowledgeGraph } from '../graph/types.js';
import { getNeo4jSchemaStatements } from './schema.js';
import { withNeo4jSession } from './driver.js';
import {
  clearRepoIndex,
  upsertNodes,
  upsertRelations,
  type Neo4jWriteProgress,
  type Neo4jWriteProgressCallback,
} from './write-adapter.js';

export interface Neo4jGraphLoadStats {
  nodes: number;
  edges: number;
}

export type Neo4jGraphLoadProgress =
  | Neo4jWriteProgress
  | { readonly operation: 'schema' | 'relinkEmbeddings' };

export type Neo4jGraphLoadProgressCallback = (progress: Neo4jGraphLoadProgress) => void;

export interface Neo4jGraphLoadOptions {
  readonly preserveEmbeddings?: boolean;
  readonly onProgress?: Neo4jGraphLoadProgressCallback;
}

const isPrimitive = (value: unknown): boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/** Neo4j 属性只支持 primitive 或 primitive 数组；嵌套对象/对象数组序列化为 JSON，null/undefined 剔除。 */
const normalizeNeo4jProperty = (value: unknown): unknown => {
  if (value === null || value === undefined) return undefined;
  if (isPrimitive(value)) return value;
  if (Array.isArray(value)) {
    return value.every(isPrimitive) ? value : JSON.stringify(value);
  }
  return JSON.stringify(value);
};

const toNodeProperties = (node: GraphNode): Record<string, any> => {
  const properties: Record<string, any> = { id: node.id };
  for (const [key, value] of Object.entries(node.properties)) {
    const normalized = normalizeNeo4jProperty(value);
    if (normalized !== undefined) properties[key] = normalized;
  }
  return properties;
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

const RELINK_EMBEDDINGS_BATCH_SIZE = 500;

const readCount = (result: unknown): number => {
  if (result === null || result === undefined) return 0;
  const value = (result as { records?: Array<{ get: (key: string) => any }> }).records?.[0]?.get(
    'count',
  );
  return typeof value?.toNumber === 'function' ? value.toNumber() : Number(value ?? 0);
};

const relinkPreservedEmbeddings = async (repoId: string): Promise<void> => {
  // 单循环合并 relink 与孤儿清理:OPTIONAL MATCH 不丢行,count(e) 恒等于本批选中数,
  // 每轮从"未连边"集合移除 500 个,count=0 即耗尽——避免内连接语义下孤儿聚类批次
  // 造成假退出、误删后续有效 embedding。全仓库单事务曾产生数十万条命令的大事务,
  // 在 store 应用阶段触发 Neo4j panic 崩溃,故保持 500/批。
  await withNeo4jSession(async (session) => {
    let processed = RELINK_EMBEDDINGS_BATCH_SIZE;
    while (processed > 0) {
      processed = await session.executeWrite(async (tx) => {
        const result = await tx.run(
          `MATCH (e:CodeEmbedding {repoId: $repoId}) WHERE NOT (e)-[:EMBEDS]->() WITH e LIMIT $batchSize OPTIONAL MATCH (n:CodeNode {repoId: $repoId, id: e.nodeId}) FOREACH (_ IN CASE WHEN n IS NOT NULL THEN [1] ELSE [] END | MERGE (e)-[:EMBEDS]->(n)) FOREACH (_ IN CASE WHEN n IS NULL THEN [1] ELSE [] END | DETACH DELETE e) RETURN count(e) AS count`,
          { repoId, batchSize: neo4j.int(RELINK_EMBEDDINGS_BATCH_SIZE) },
        );
        return readCount(result);
      });
    }
  });
};

export const loadGraphToNeo4j = async (
  repoId: string,
  graph: KnowledgeGraph,
  options: Neo4jGraphLoadOptions = {},
): Promise<Neo4jGraphLoadStats> => {
  options.onProgress?.({ operation: 'schema' });
  await applyNeo4jSchema();
  await clearRepoIndex(repoId, {
    preserveEmbeddings: options.preserveEmbeddings,
    onProgress: options.onProgress,
  });

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

  await upsertNodes(repoId, nodes, options.onProgress);
  await upsertRelations(repoId, relationships, options.onProgress);
  if (options.preserveEmbeddings) {
    options.onProgress?.({ operation: 'relinkEmbeddings' });
    await relinkPreservedEmbeddings(repoId);
  }

  return {
    nodes: nodes.length,
    edges: relationships.length,
  };
};
