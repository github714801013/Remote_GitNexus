import { EMBEDDING_TABLE_NAME } from 'gitnexus-shared';
import {
  EMBEDDABLE_LABELS,
  LABEL_METHOD,
  LABELS_WITH_EXPORTED,
  type EmbeddableNode,
  type ExistingEmbeddingHashes,
} from '../embeddings/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import neo4j from 'neo4j-driver';
import { withNeo4jSession } from './driver.js';
import { applyNeo4jSchema } from './graph-loader.js';

export interface Neo4jEmbeddingInput {
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  embedding: number[];
  contentHash?: string;
  summaryText?: string;
}

export interface Neo4jDescriptionInput {
  nodeId: string;
  label: string;
  description: string;
}

export interface Neo4jSemanticSearchResult {
  repoId?: string;
  nodeId: string;
  name: string;
  type: string;
  filePath: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  score: number;
  distance: number;
}

const recordGet = (record: any, key: string): any => {
  return typeof record?.get === 'function' ? record.get(key) : record?.[key];
};

const toNumber = (value: any, fallback = 0): number => {
  if (typeof value?.toNumber === 'function') return value.toNumber();
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const EMBEDDABLE_LABEL_EXPRESSION = EMBEDDABLE_LABELS.map((label) => `\`${label}\``).join('|');
export const DELETE_EMBEDDINGS_NODE_ID_BATCH_SIZE = 500;
const SOURCE_SNIPPET_CONTEXT_LINES = 2;
const MAX_SOURCE_SNIPPET_CHARS = 5000;

const isPathInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  );
};

const loadSourceSnippet = async (
  repoPath: string,
  node: Pick<EmbeddableNode, 'filePath' | 'startLine' | 'endLine'>,
  fileCache: Map<string, string | null>,
): Promise<string> => {
  if (!node.filePath || node.startLine <= 0 || node.endLine <= 0) return '';

  const root = path.resolve(repoPath);
  const resolvedFilePath = path.resolve(root, node.filePath);
  if (!isPathInside(root, resolvedFilePath)) return '';

  let fileContent = fileCache.get(resolvedFilePath);
  if (fileContent === undefined) {
    try {
      fileContent = await fs.readFile(resolvedFilePath, 'utf-8');
    } catch {
      fileContent = null;
    }
    fileCache.set(resolvedFilePath, fileContent);
  }
  if (!fileContent) return '';

  const lines = fileContent.split(/\r?\n/);
  const startIndex = Math.max(0, node.startLine - SOURCE_SNIPPET_CONTEXT_LINES - 1);
  const endIndex = Math.min(lines.length, node.endLine + SOURCE_SNIPPET_CONTEXT_LINES);
  return lines.slice(startIndex, endIndex).join('\n').slice(0, MAX_SOURCE_SNIPPET_CHARS);
};

export const fetchExistingEmbeddingHashes = async (
  repoId: string,
): Promise<ExistingEmbeddingHashes> => {
  return await withNeo4jSession(async (session) => {
    return await session.executeRead(async (tx) => {
      const result = await tx.run(
        `MATCH (e:\`${EMBEDDING_TABLE_NAME}\` {repoId: $repoId}) RETURN e.nodeId AS nodeId, head(collect(e.contentHash)) AS contentHash, count(e) AS chunkCount`,
        { repoId },
      );
      const hashes: ExistingEmbeddingHashes = new Map();
      for (const record of result.records ?? []) {
        const nodeId = String(recordGet(record, 'nodeId') ?? '');
        if (!nodeId) continue;
        hashes.set(nodeId, {
          contentHash: String(recordGet(record, 'contentHash') ?? ''),
          chunkCount: toNumber(recordGet(record, 'chunkCount'), 0),
        });
      }
      return hashes;
    });
  });
};

export const loadEmbeddableNodes = async (
  repoId: string,
  repoPath?: string,
): Promise<EmbeddableNode[]> => {
  const nodes: EmbeddableNode[] = [];

  await withNeo4jSession(async (session) => {
    await session.executeRead(async (tx) => {
      for (const label of EMBEDDABLE_LABELS) {
        const hasExportedColumn = label === LABEL_METHOD || LABELS_WITH_EXPORTED.has(label);
        const methodFields =
          label === LABEL_METHOD
            ? ', n.parameterCount AS parameterCount, n.returnType AS returnType'
            : '';
        const result = await tx.run(
          `
MATCH (n:\`${label}\` {repoId: $repoId})
RETURN n.id AS id,
       n.name AS name,
       '${label}' AS label,
       n.filePath AS filePath,
       n.content AS content,
       n.startLine AS startLine,
       n.endLine AS endLine,
       n.isExported AS isExported,
       n.description AS description
       ${methodFields}
          `.trim(),
          { repoId },
        );

        for (const record of result.records ?? []) {
          nodes.push({
            id: String(recordGet(record, 'id') ?? ''),
            name: String(recordGet(record, 'name') ?? ''),
            label,
            filePath: String(recordGet(record, 'filePath') ?? ''),
            content: String(recordGet(record, 'content') ?? ''),
            startLine: toNumber(recordGet(record, 'startLine')),
            endLine: toNumber(recordGet(record, 'endLine')),
            isExported: hasExportedColumn ? Boolean(recordGet(record, 'isExported')) : undefined,
            description: recordGet(record, 'description') ?? undefined,
            ...(label === LABEL_METHOD
              ? {
                  parameterCount: toNumber(recordGet(record, 'parameterCount')),
                  returnType: recordGet(record, 'returnType') ?? undefined,
                }
              : {}),
          });
        }
      }
    });
  });

  const embeddableNodes = nodes.filter((node) => node.id);
  if (!repoPath) return embeddableNodes;

  const fileCache = new Map<string, string | null>();
  return await Promise.all(
    embeddableNodes.map(async (node) => {
      if (node.content.trim()) return node;
      const content = await loadSourceSnippet(repoPath, node, fileCache);
      return content ? { ...node, content } : node;
    }),
  );
};

export const deleteEmbeddingsForNodes = async (
  repoId: string,
  nodeIds: string[],
): Promise<void> => {
  if (nodeIds.length === 0) return;

  await withNeo4jSession(async (session) => {
    for (let i = 0; i < nodeIds.length; i += DELETE_EMBEDDINGS_NODE_ID_BATCH_SIZE) {
      const batchNodeIds = nodeIds.slice(i, i + DELETE_EMBEDDINGS_NODE_ID_BATCH_SIZE);
      await session.executeWrite(async (tx) => {
        await tx.run(
          `MATCH (e:\`${EMBEDDING_TABLE_NAME}\` {repoId: $repoId}) WHERE e.nodeId IN $nodeIds DETACH DELETE e`,
          { repoId, nodeIds: batchNodeIds },
        );
      });
    }
  });
};

export const upsertEmbeddings = async (
  repoId: string,
  updates: Neo4jEmbeddingInput[],
): Promise<void> => {
  if (updates.length === 0) return;

  await withNeo4jSession(async (session) => {
    await session.executeWrite(async (tx) => {
      await tx.run(
        `UNWIND $embeddings AS row MERGE (e:\`${EMBEDDING_TABLE_NAME}\` {repoId: $repoId, id: row.id}) SET e += row.props WITH e, row MATCH (n:${EMBEDDABLE_LABEL_EXPRESSION} {repoId: $repoId, id: row.nodeId}) MERGE (e)-[:EMBEDS]->(n)`,
        {
          repoId,
          embeddings: updates.map((update) => {
            const id = `${update.nodeId}:${update.chunkIndex}`;
            return {
              id,
              nodeId: update.nodeId,
              props: {
                repoId,
                id,
                nodeId: update.nodeId,
                chunkIndex: update.chunkIndex,
                startLine: update.startLine,
                endLine: update.endLine,
                embedding: update.embedding,
                contentHash: update.contentHash ?? '',
                summaryText: update.summaryText ?? '',
              },
            };
          }),
        },
      );
    });
  });
};

export const updateNodeDescriptions = async (
  repoId: string,
  updates: Neo4jDescriptionInput[],
): Promise<void> => {
  const grouped = new Map<string, Array<{ nodeId: string; description: string }>>();
  const allowedLabels = new Set<string>(EMBEDDABLE_LABELS);

  for (const update of updates) {
    if (!allowedLabels.has(update.label)) continue;
    const description = update.description.trim();
    if (!description) continue;
    const bucket = grouped.get(update.label) ?? [];
    bucket.push({ nodeId: update.nodeId, description });
    grouped.set(update.label, bucket);
  }

  if (grouped.size === 0) return;

  await withNeo4jSession(async (session) => {
    for (const [label, rows] of grouped) {
      await session.executeWrite(async (tx) => {
        await tx.run(
          `UNWIND $updates AS row MATCH (n:\`${label}\` {repoId: $repoId, id: row.nodeId}) SET n.description = row.description`,
          { repoId, updates: rows },
        );
      });
    }
  });
};

export const ensureNeo4jEmbeddingIndex = async (): Promise<void> => {
  await applyNeo4jSchema();
};

export const countEmbeddings = async (repoId: string): Promise<number> => {
  return await withNeo4jSession(async (session) => {
    return await session.executeRead(async (tx) => {
      const result = await tx.run(
        `MATCH (e:\`${EMBEDDING_TABLE_NAME}\` {repoId: $repoId}) RETURN count(e) AS cnt`,
        { repoId },
      );
      return toNumber(result.records?.[0] ? recordGet(result.records[0], 'cnt') : 0);
    });
  });
};

export const semanticSearch = async (
  repoId: string,
  queryVector: number[],
  limit: number,
): Promise<Neo4jSemanticSearchResult[]> => {
  return await semanticSearchMany([repoId], queryVector, limit);
};

export const semanticSearchMany = async (
  repoIds: string[],
  queryVector: number[],
  limit: number,
): Promise<Neo4jSemanticSearchResult[]> => {
  if (limit <= 0) return [];
  if (repoIds.length === 0) return [];

  const boundedLimit = Math.max(1, Math.trunc(limit));
  const fetchLimit = Math.max(boundedLimit * 5, boundedLimit);
  return await withNeo4jSession(async (session) => {
    return await session.executeRead(async (tx) => {
      const result = await tx.run(
        `
CALL db.index.vector.queryNodes('code_embedding_idx', $fetchLimit, $queryVector)
YIELD node, score
WHERE node.repoId IN $repoIds AND score >= $minScore
MATCH (node)-[:EMBEDS]->(symbol)
RETURN node.repoId AS repoId,
       node.nodeId AS nodeId,
       symbol.name AS name,
       labels(symbol)[0] AS type,
       symbol.filePath AS filePath,
       node.chunkIndex AS chunkIndex,
       node.startLine AS startLine,
       node.endLine AS endLine,
       score
ORDER BY score DESC
LIMIT $limit
        `.trim(),
        {
          repoIds,
          queryVector,
          fetchLimit: neo4j.int(fetchLimit),
          limit: neo4j.int(boundedLimit),
          minScore: 0.1,
        },
      );

      return (result.records ?? []).map((record: any) => {
        const score = toNumber(recordGet(record, 'score'));
        return {
          repoId: String(recordGet(record, 'repoId') ?? ''),
          nodeId: String(recordGet(record, 'nodeId') ?? ''),
          name: String(recordGet(record, 'name') ?? ''),
          type: String(recordGet(record, 'type') ?? ''),
          filePath: String(recordGet(record, 'filePath') ?? ''),
          chunkIndex: toNumber(recordGet(record, 'chunkIndex')),
          startLine: toNumber(recordGet(record, 'startLine')),
          endLine: toNumber(recordGet(record, 'endLine')),
          score,
          distance: 1 - score,
        };
      });
    });
  });
};
