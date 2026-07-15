import { NODE_TABLES, type GraphNode, type GraphRelationship } from 'gitnexus-shared';
import neo4j from 'neo4j-driver';
import { logger } from '../core/logger.js';
import type { EmbeddableNode } from '../core/embeddings/types.js';

export type HttpSearchMode = 'hybrid' | 'semantic' | 'bm25' | string;

export interface Neo4jHttpSearchParams {
  repoName: string;
  query: string;
  mode: HttpSearchMode;
  limit: number;
}

const toNeo4jLimit = (limit: number): neo4j.Integer => neo4j.int(Math.max(0, Math.trunc(limit)));

export const searchNeo4jBackend = async ({
  repoName,
  query,
  mode,
  limit,
}: Neo4jHttpSearchParams): Promise<any[]> => {
  if (mode === 'bm25') {
    return [];
  }

  const { embedQuery } = await import('../mcp/core/embedder.js');
  const queryVector = await embedQuery(query);
  const { semanticSearch } = await import('../core/neo4j/embedding-adapter.js');
  const results = await semanticSearch(repoName, queryVector, limit);

  return results.map((result, index) => ({
    ...result,
    label: result.type,
    score: result.score ?? 1 - (result.distance ?? 0),
    rank: index + 1,
    sources: ['semantic'],
  }));
};

export const queryNeo4jBackend = async (
  cypher: string,
  repoName?: string,
): Promise<Record<string, any>[]> => {
  const { executeRepoScopedReadCypher } = await import('../core/neo4j/read-adapter.js');
  return await executeRepoScopedReadCypher(cypher, repoName);
};

export const queryNeo4jProcesses = async (
  repoName: string,
  limit = 50,
): Promise<{ processes: any[] }> => {
  const { executeReadCypher } = await import('../core/neo4j/read-adapter.js');
  const processes = await executeReadCypher(
    `
MATCH (p:Process {repoId: $repoId})
RETURN p.id AS id,
       p.label AS label,
       p.heuristicLabel AS heuristicLabel,
       p.processType AS processType,
       p.stepCount AS stepCount
ORDER BY p.stepCount DESC
LIMIT $limit
    `.trim(),
    { repoId: repoName, limit: toNeo4jLimit(limit) },
  );

  return { processes };
};

export const queryNeo4jClusters = async (
  repoName: string,
  limit = 100,
): Promise<{ clusters: any[] }> => {
  const { executeReadCypher } = await import('../core/neo4j/read-adapter.js');
  const clusters = await executeReadCypher(
    `
MATCH (c:Community {repoId: $repoId})
RETURN c.id AS id,
       c.label AS label,
       c.heuristicLabel AS heuristicLabel,
       c.cohesion AS cohesion,
       c.symbolCount AS symbolCount
ORDER BY c.symbolCount DESC
LIMIT $limit
    `.trim(),
    { repoId: repoName, limit: toNeo4jLimit(limit) },
  );

  return { clusters };
};

export const queryNeo4jProcessDetail = async (name: string, repoName: string): Promise<any> => {
  const { executeReadCypher } = await import('../core/neo4j/read-adapter.js');
  const processes = await executeReadCypher(
    `
MATCH (p:Process {repoId: $repoId})
WHERE p.label = $name OR p.heuristicLabel = $name
RETURN p.id AS id,
       p.label AS label,
       p.heuristicLabel AS heuristicLabel,
       p.processType AS processType,
       p.stepCount AS stepCount
LIMIT 1
    `.trim(),
    { repoId: repoName, name },
  );
  if (processes.length === 0) return { error: `Process '${name}' not found` };

  const process = processes[0];
  const steps = await executeReadCypher(
    `
MATCH (n {repoId: $repoId})-[r:STEP_IN_PROCESS]->(p:Process {repoId: $repoId, id: $processId})
RETURN n.name AS name,
       labels(n)[0] AS type,
       n.filePath AS filePath,
       r.step AS step
ORDER BY r.step
    `.trim(),
    { repoId: repoName, processId: process.id },
  );

  return { process, steps };
};

export const queryNeo4jClusterDetail = async (name: string, repoName: string): Promise<any> => {
  const { executeReadCypher } = await import('../core/neo4j/read-adapter.js');
  const clusters = await executeReadCypher(
    `
MATCH (c:Community {repoId: $repoId})
WHERE c.label = $name OR c.heuristicLabel = $name
RETURN c.id AS id,
       c.label AS label,
       c.heuristicLabel AS heuristicLabel,
       c.cohesion AS cohesion,
       c.symbolCount AS symbolCount
LIMIT 1
    `.trim(),
    { repoId: repoName, name },
  );
  if (clusters.length === 0) return { error: `Cluster '${name}' not found` };

  const cluster = clusters[0];
  const members = await executeReadCypher(
    `
MATCH (n {repoId: $repoId})-[:MEMBER_OF]->(c:Community {repoId: $repoId, id: $clusterId})
RETURN DISTINCT n.name AS name,
       labels(n)[0] AS type,
       n.filePath AS filePath
LIMIT 30
    `.trim(),
    { repoId: repoName, clusterId: cluster.id },
  );

  return { cluster, members };
};

export const listNeo4jFilePaths = async (repoName: string): Promise<string[]> => {
  const { executeReadCypher } = await import('../core/neo4j/read-adapter.js');
  const rows = await executeReadCypher(
    `
MATCH (f:File {repoId: $repoId})
RETURN f.filePath AS filePath
ORDER BY f.filePath
    `.trim(),
    { repoId: repoName },
  );

  return rows.map((row) => String(row.filePath ?? '')).filter(Boolean);
};

const quoteNodeLabel = (label: string): string => `\`${label.replace(/`/g, '``')}\``;

const neo4jNodeQuery = (label: string, includeContent: boolean): string => {
  const quoted = quoteNodeLabel(label);
  if (label === 'File') {
    return includeContent
      ? `MATCH (n:${quoted} {repoId: $repoId}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.content AS content`
      : `MATCH (n:${quoted} {repoId: $repoId}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
  }
  if (label === 'Folder') {
    return `MATCH (n:${quoted} {repoId: $repoId}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
  }
  if (label === 'Community') {
    return `MATCH (n:${quoted} {repoId: $repoId}) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount`;
  }
  if (label === 'Process') {
    return `MATCH (n:${quoted} {repoId: $repoId}) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.processType AS processType, n.stepCount AS stepCount, n.communities AS communities, n.entryPointId AS entryPointId, n.terminalId AS terminalId`;
  }
  if (label === 'Route') {
    return `MATCH (n:${quoted} {repoId: $repoId}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.responseKeys AS responseKeys, n.errorKeys AS errorKeys, n.middleware AS middleware`;
  }
  if (label === 'Tool') {
    return `MATCH (n:${quoted} {repoId: $repoId}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.description AS description`;
  }
  return includeContent
    ? `MATCH (n:${quoted} {repoId: $repoId}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content`
    : `MATCH (n:${quoted} {repoId: $repoId}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine`;
};

const mapNeo4jGraphNode = (
  label: string,
  row: Record<string, any>,
  includeContent: boolean,
): GraphNode => ({
  id: row.id,
  label: label as GraphNode['label'],
  properties: {
    name: row.name ?? row.label,
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    content: includeContent ? row.content : undefined,
    responseKeys: row.responseKeys,
    errorKeys: row.errorKeys,
    middleware: row.middleware,
    heuristicLabel: row.heuristicLabel,
    cohesion: row.cohesion,
    symbolCount: row.symbolCount,
    description: row.description,
    processType: row.processType,
    stepCount: row.stepCount,
    communities: row.communities,
    entryPointId: row.entryPointId,
    terminalId: row.terminalId,
  } as GraphNode['properties'],
});

const mapNeo4jGraphRelationship = (row: Record<string, any>): GraphRelationship => ({
  id: `${row.sourceId}_${row.type}_${row.targetId}`,
  type: row.type,
  sourceId: row.sourceId,
  targetId: row.targetId,
  confidence: row.confidence,
  reason: row.reason,
  step: row.step,
});

export const buildNeo4jGraph = async (
  repoName: string,
  includeContent = false,
): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  const { executeReadCypher } = await import('../core/neo4j/read-adapter.js');
  const nodes: GraphNode[] = [];

  for (const label of NODE_TABLES) {
    const rows = await executeReadCypher(neo4jNodeQuery(label, includeContent), {
      repoId: repoName,
    });
    for (const row of rows) {
      nodes.push(mapNeo4jGraphNode(label, row, includeContent));
    }
  }

  const relRows = await executeReadCypher(
    `
MATCH (a {repoId: $repoId})-[r]->(b {repoId: $repoId})
WHERE NOT a:CodeEmbedding AND NOT b:CodeEmbedding AND type(r) <> 'EMBEDS'
RETURN a.id AS sourceId,
       b.id AS targetId,
       type(r) AS type,
       r.confidence AS confidence,
       r.reason AS reason,
       r.step AS step
    `.trim(),
    { repoId: repoName },
  );

  return {
    nodes,
    relationships: relRows.map(mapNeo4jGraphRelationship),
  };
};

export type EmbeddingProgressCallback = (progress: any) => void;

const NEO4J_EMBEDDING_REPAIR_BATCH_SIZE = 16;
const DEFAULT_EMBEDDING_REPAIR_REPO_COOLDOWN_MS = 5 * 60_000;
const embeddingRepairCooldownByRepo = new Map<string, number>();

export class Neo4jEmbeddingRepairCooldownError extends Error {
  constructor(
    readonly repoName: string,
    readonly retryAfterMs: number,
  ) {
    super(
      `Neo4j embedding repair for repo "${repoName}" is cooling down; retry after ${Math.ceil(
        retryAfterMs / 1000,
      )}s`,
    );
    this.name = 'Neo4jEmbeddingRepairCooldownError';
  }
}

export class Neo4jEmbeddingRepairDeferredError extends Error {
  constructor(
    readonly repoName: string,
    readonly skippedNodes: number,
    readonly retryAfterMs: number,
  ) {
    super(
      `Neo4j embedding repair failed for all ${skippedNodes} nodes in repo "${repoName}"; repo is cooling down before retry`,
    );
    this.name = 'Neo4jEmbeddingRepairDeferredError';
  }
}

export const isNeo4jEmbeddingRepairCooldownError = (
  err: unknown,
): err is Neo4jEmbeddingRepairCooldownError | Neo4jEmbeddingRepairDeferredError =>
  err instanceof Neo4jEmbeddingRepairCooldownError ||
  err instanceof Neo4jEmbeddingRepairDeferredError;

const readPositiveInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const readEmbeddingRepairRepoCooldownMs = (): number =>
  readPositiveInt(
    process.env.GITNEXUS_EMBEDDING_REPAIR_REPO_COOLDOWN_MS,
    DEFAULT_EMBEDDING_REPAIR_REPO_COOLDOWN_MS,
  );

const assertEmbeddingRepairNotCoolingDown = (repoName: string): void => {
  const disabledUntil = embeddingRepairCooldownByRepo.get(repoName) ?? 0;
  const retryAfterMs = disabledUntil - Date.now();
  if (retryAfterMs > 0) {
    throw new Neo4jEmbeddingRepairCooldownError(repoName, retryAfterMs);
  }
  embeddingRepairCooldownByRepo.delete(repoName);
};

const coolDownEmbeddingRepairRepo = (repoName: string): void => {
  embeddingRepairCooldownByRepo.set(repoName, Date.now() + readEmbeddingRepairRepoCooldownMs());
};

export const runNeo4jEmbeddingRepair = async (
  repoName: string,
  onProgress: EmbeddingProgressCallback,
  repoPath?: string,
): Promise<number> => {
  assertEmbeddingRepairNotCoolingDown(repoName);
  const { contentHashForNode } = await import('../core/embeddings/embedding-pipeline.js');
  const { shouldSummarizeNode } = await import('../core/embeddings/keyword-summary.js');
  const { embedBatch, embeddingToArray } = await import('../core/embeddings/embedder.js');
  const { buildNeo4jEmbeddingText } = await import('./neo4j-embedding-text.js');
  const {
    countEmbeddings,
    deleteEmbeddingsForNodes,
    ensureNeo4jEmbeddingIndex,
    fetchExistingEmbeddingHashes,
    countEmbeddableNodes,
    loadEmbeddableNodeBatches,
    updateNodeDescriptions,
    upsertEmbeddings,
  } = await import('../core/neo4j/embedding-adapter.js');
  const resolvedRepoPath =
    repoPath ??
    (await import('../storage/repo-manager.js').then(
      async ({ readRegistry, resolveRegistryEntry }) => {
        try {
          return resolveRegistryEntry(await readRegistry(), repoName).path;
        } catch {
          return undefined;
        }
      },
    ));

  onProgress({ phase: 'loading-model', percent: 0 });
  await ensureNeo4jEmbeddingIndex();
  const totalNodes = await countEmbeddableNodes(repoName);
  const existingEmbeddings = await fetchExistingEmbeddingHashes(repoName);

  let processed = 0;
  let embedded = 0;
  let skipped = 0;
  let nodesToEmbedCount = 0;

  const persistEmbeddingInputs = async (
    embeddingInputs: Array<{
      node: EmbeddableNode;
      contentHash: string;
      embeddingText: string;
      summaryText?: string;
    }>,
  ): Promise<number> => {
    if (embeddingInputs.length === 0) return 0;
    const texts = embeddingInputs.map((input) => input.embeddingText);
    let vectors: Float32Array[];
    try {
      vectors = await embedBatch(texts);
    } catch (err) {
      if (embeddingInputs.length > 1) {
        logger.warn(
          {
            err,
            repo: repoName,
            batchSize: embeddingInputs.length,
            nextBatchSize: Math.ceil(embeddingInputs.length / 2),
          },
          'Neo4j embedding repair batch failed; splitting batch',
        );
        const midpoint = Math.ceil(embeddingInputs.length / 2);
        const left = await persistEmbeddingInputs(embeddingInputs.slice(0, midpoint));
        const right = await persistEmbeddingInputs(embeddingInputs.slice(midpoint));
        return left + right;
      }

      const failed = embeddingInputs[0];
      logger.warn(
        {
          err,
          repo: repoName,
          nodeId: failed.node.id,
        },
        'Neo4j embedding repair skipped node after repeated embedding failures',
      );
      return 0;
    }

    await upsertEmbeddings(
      repoName,
      embeddingInputs.map(({ node, contentHash, summaryText }, index) => ({
        nodeId: node.id,
        chunkIndex: 0,
        startLine: node.startLine ?? 0,
        endLine: node.endLine ?? node.startLine ?? 0,
        embedding: embeddingToArray(vectors[index]),
        contentHash,
        summaryText,
      })),
    );

    const descriptionUpdates = embeddingInputs
      .filter((input) => input.summaryText?.trim())
      .map(({ node, summaryText }) => ({
        nodeId: node.id,
        label: node.label,
        description: summaryText!,
      }));
    await updateNodeDescriptions(repoName, descriptionUpdates);
    return embeddingInputs.length;
  };

  for await (const nodePage of loadEmbeddableNodeBatches(repoName, resolvedRepoPath)) {
    const nodesToEmbed = nodePage.filter((node) => {
      const currentHash = contentHashForNode(node);
      const existing = existingEmbeddings.get(node.id);
      return (
        existing === undefined ||
        existing.contentHash !== currentHash ||
        (shouldSummarizeNode(node) && !existing.hasSummaryText)
      );
    });
    const staleNodeIds = nodesToEmbed
      .filter((node) => {
        const existing = existingEmbeddings.get(node.id);
        return existing !== undefined && existing.contentHash !== contentHashForNode(node);
      })
      .map((node) => node.id);
    if (staleNodeIds.length > 0) {
      await deleteEmbeddingsForNodes(repoName, staleNodeIds);
    }

    nodesToEmbedCount += nodesToEmbed.length;
    for (let i = 0; i < nodesToEmbed.length; i += NEO4J_EMBEDDING_REPAIR_BATCH_SIZE) {
      const batch = nodesToEmbed.slice(i, i + NEO4J_EMBEDDING_REPAIR_BATCH_SIZE);
      const embeddingInputs = await Promise.all(
        batch.map(async (node) => {
          const contentHash = contentHashForNode(node);
          const { embeddingText, summaryText } = await buildNeo4jEmbeddingText(node, contentHash);
          return { node, contentHash, embeddingText, summaryText };
        }),
      );
      const embeddedInBatch = await persistEmbeddingInputs(embeddingInputs);
      embedded += embeddedInBatch;
      skipped += batch.length - embeddedInBatch;

      processed += batch.length;
      onProgress({
        phase: 'embedding',
        percent: totalNodes === 0 ? 100 : Math.min(90, Math.round((processed / totalNodes) * 90)),
        nodesProcessed: processed,
        totalNodes,
        nodesEmbedded: embedded,
        nodesSkipped: skipped,
      });
    }
  }

  if (nodesToEmbedCount > 0 && embedded === 0 && skipped > 0) {
    const cooldownMs = readEmbeddingRepairRepoCooldownMs();
    coolDownEmbeddingRepairRepo(repoName);
    throw new Neo4jEmbeddingRepairDeferredError(repoName, skipped, cooldownMs);
  }

  onProgress({ phase: 'indexing', percent: 95 });
  await ensureNeo4jEmbeddingIndex();
  onProgress({ phase: 'ready', percent: 100 });

  return await countEmbeddings(repoName);
};
