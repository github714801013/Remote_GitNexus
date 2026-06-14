import { NODE_TABLES, type GraphNode, type GraphRelationship } from 'gitnexus-shared';
import neo4j from 'neo4j-driver';

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

export const queryNeo4jBackend = async (cypher: string): Promise<Record<string, any>[]> => {
  const { executeReadCypher } = await import('../core/neo4j/read-adapter.js');
  return await executeReadCypher(cypher);
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

export const runNeo4jEmbeddingRepair = async (
  repoName: string,
  onProgress: EmbeddingProgressCallback,
): Promise<number> => {
  const { runEmbeddingPipeline } = await import('../core/embeddings/embedding-pipeline.js');
  const { withEmbeddingBaseUrl } = await import('../core/embeddings/http-client.js');
  const {
    countEmbeddings,
    deleteEmbeddingsForNodes,
    ensureNeo4jEmbeddingIndex,
    fetchExistingEmbeddingHashes,
    loadEmbeddableNodes,
    upsertEmbeddings,
  } = await import('../core/neo4j/embedding-adapter.js');
  const { readServerMapping } = await import('../core/embeddings/server-mapping.js');

  const serverName = await readServerMapping(repoName);
  const existingEmbeddings = await fetchExistingEmbeddingHashes(repoName);
  await withEmbeddingBaseUrl(process.env.GITNEXUS_INDEX_EMBEDDING_URL, async () =>
    runEmbeddingPipeline(
      async () => [],
      async () => {},
      onProgress,
      {},
      undefined,
      { repoName, serverName },
      existingEmbeddings,
      {
        loadNodes: () => loadEmbeddableNodes(repoName),
        insertEmbeddings: (updates) => upsertEmbeddings(repoName, updates),
        deleteEmbeddingsForNodeIds: (nodeIds) => deleteEmbeddingsForNodes(repoName, nodeIds),
        ensureVectorIndex: ensureNeo4jEmbeddingIndex,
      },
    ),
  );

  return await countEmbeddings(repoName);
};
