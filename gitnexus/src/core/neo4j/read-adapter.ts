import { isWriteQuery } from '../lbug/pool-adapter.js';
import neo4j from 'neo4j-driver';
import { withNeo4jSession } from './driver.js';

export type Neo4jImpactDirection = 'upstream' | 'downstream';

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

export const findSymbolContext = async (
  repoId: string,
  target: string,
  limit = 10,
): Promise<Record<string, any>[]> => {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  return await executeReadCypher(
    `
MATCH (n {repoId: $repoId})
WHERE n.id = $target OR n.name = $target
OPTIONAL MATCH (n)-[out]->(callee {repoId: $repoId})
OPTIONAL MATCH (caller {repoId: $repoId})-[in]->(n)
RETURN n.id AS id,
       n.name AS name,
       labels(n)[0] AS type,
       n.filePath AS filePath,
       collect(DISTINCT {type: type(out), target: callee.id, targetName: callee.name}) AS outgoing,
       collect(DISTINCT {type: type(in), source: caller.id, sourceName: caller.name}) AS incoming
LIMIT $limit
    `.trim(),
    { repoId, target, limit: neo4j.int(boundedLimit) },
  );
};

export const findImpact = async (
  repoId: string,
  target: string,
  direction: Neo4jImpactDirection,
  depth = 1,
): Promise<Record<string, any>[]> => {
  const boundedDepth = clampDepth(depth);
  const query =
    direction === 'upstream'
      ? `
MATCH (target {repoId: $repoId})
WHERE target.id = $target OR target.name = $target
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
MATCH path = (source)-[*1..${boundedDepth}]->(target {repoId: $repoId})
RETURN DISTINCT target.id AS id,
       target.name AS name,
       labels(target)[0] AS type,
       target.filePath AS filePath,
       length(path) AS depth
ORDER BY depth ASC, name ASC
        `.trim();

  return await executeReadCypher(query, { repoId, target });
};
