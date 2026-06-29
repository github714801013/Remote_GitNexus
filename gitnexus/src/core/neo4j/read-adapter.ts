import { isWriteQuery } from '../lbug/pool-adapter.js';
import neo4j from 'neo4j-driver';
import { withNeo4jSession } from './driver.js';

export type Neo4jImpactDirection = 'upstream' | 'downstream';

export interface Neo4jSymbolLookupOptions {
  filePath?: string;
  kind?: string;
}

const mapRecord = (record: any): Record<string, any> => {
  const keys = Array.isArray(record?.keys) ? record.keys : Object.keys(record ?? {});
  const row: Record<string, any> = {};
  for (const key of keys) {
    row[key] = typeof record?.get === 'function' ? record.get(key) : record[key];
  }
  return row;
};

const clampDepth = (depth: number): number => {
  if (!Number.isFinite(depth)) return 1;
  return Math.max(1, Math.min(5, Math.trunc(depth)));
};

const normalizePathHint = (filePath: string | undefined): string | null => {
  const normalized = filePath?.trim().replace(/\\/g, '/').toLowerCase();
  return normalized || null;
};

export const executeReadCypher = async (
  cypher: string,
  params: Record<string, any> = {},
): Promise<Record<string, any>[]> => {
  if (isWriteQuery(cypher)) {
    throw new Error('Write operations are not allowed in Neo4j read queries.');
  }

  return await withNeo4jSession(async (session) => {
    return await session.executeRead(async (tx) => {
      const result = await tx.run(cypher, params);
      return (result.records ?? []).map(mapRecord);
    });
  });
};

export const REPO_SCOPED_CYPHER_REQUIRES_REPO_ID =
  'Repo-scoped Neo4j Cypher queries must explicitly filter with the $repoId parameter, for example: MATCH (n {repoId: $repoId}) RETURN n LIMIT 10.';

const usesRepoIdParameter = (cypher: string): boolean => /\$repoId\b/.test(cypher);

export const executeRepoScopedReadCypher = async (
  cypher: string,
  repoId?: string,
): Promise<Record<string, any>[]> => {
  if (!repoId) {
    return await executeReadCypher(cypher);
  }
  if (!usesRepoIdParameter(cypher)) {
    throw new Error(REPO_SCOPED_CYPHER_REQUIRES_REPO_ID);
  }
  return await executeReadCypher(cypher, { repoId });
};

export const findSymbolContext = async (
  repoId: string,
  target: string,
  limit = 10,
  options: Neo4jSymbolLookupOptions = {},
): Promise<Record<string, any>[]> => {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const filePath = normalizePathHint(options.filePath);
  const kind = options.kind?.trim() || null;
  return await executeReadCypher(
    `
MATCH (n {repoId: $repoId})
WHERE n.id = $target OR n.name = $target
WITH n
WHERE ($filePath IS NULL OR replace(toLower(coalesce(n.filePath, '')), '\\\\', '/') CONTAINS $filePath)
  AND ($kind IS NULL OR $kind IN labels(n))
WITH n
ORDER BY CASE WHEN n.id = $target THEN 0 ELSE 1 END,
         CASE WHEN $filePath IS NOT NULL AND replace(toLower(coalesce(n.filePath, '')), '\\\\', '/') = $filePath THEN 0 ELSE 1 END,
         size(coalesce(n.filePath, '')) ASC,
         n.id ASC
LIMIT $limit
OPTIONAL MATCH (n)-[out]->(callee {repoId: $repoId})
OPTIONAL MATCH (caller {repoId: $repoId})-[in]->(n)
RETURN n.id AS id,
       n.name AS name,
       labels(n)[0] AS type,
       n.filePath AS filePath,
       collect(DISTINCT {type: type(out), target: callee.id, targetName: callee.name}) AS outgoing,
       collect(DISTINCT {type: type(in), source: caller.id, sourceName: caller.name}) AS incoming
    `.trim(),
    { repoId, target, filePath, kind, limit: neo4j.int(boundedLimit) },
  );
};

export const findImpact = async (
  repoId: string,
  target: string,
  direction: Neo4jImpactDirection,
  depth = 1,
  options: Neo4jSymbolLookupOptions = {},
): Promise<Record<string, any>[]> => {
  const boundedDepth = clampDepth(depth);
  const filePath = normalizePathHint(options.filePath);
  const kind = options.kind?.trim() || null;
  const query =
    direction === 'upstream'
      ? `
MATCH (target {repoId: $repoId})
WHERE target.id = $target OR target.name = $target
WITH target
WHERE ($filePath IS NULL OR replace(toLower(coalesce(target.filePath, '')), '\\\\', '/') CONTAINS $filePath)
  AND ($kind IS NULL OR $kind IN labels(target))
MATCH path = (source {repoId: $repoId})-[*1..${boundedDepth}]->(target)
RETURN DISTINCT source.id AS id,
       source.name AS name,
       labels(source)[0] AS type,
       source.filePath AS filePath,
       length(path) AS depth
ORDER BY depth ASC, name ASC
        `.trim()
      : `
MATCH (source {repoId: $repoId})
WHERE source.id = $target OR source.name = $target
WITH source
WHERE ($filePath IS NULL OR replace(toLower(coalesce(source.filePath, '')), '\\\\', '/') CONTAINS $filePath)
  AND ($kind IS NULL OR $kind IN labels(source))
MATCH path = (source)-[*1..${boundedDepth}]->(target {repoId: $repoId})
RETURN DISTINCT target.id AS id,
       target.name AS name,
       labels(target)[0] AS type,
       target.filePath AS filePath,
       length(path) AS depth
ORDER BY depth ASC, name ASC
        `.trim();

  return await executeReadCypher(query, { repoId, target, filePath, kind });
};
