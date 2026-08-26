/**
 * Graph Queries for Wiki Generation
 *
 * Encapsulated Cypher queries against the GitNexus knowledge graph.
 * Uses the MCP-style pooled lbug-adapter for connection management.
 */

import { initLbug, executeQuery, closeLbug, touchRepo, pinRepo } from '../lbug/pool-adapter.js';
import { escapeCypherString } from '../lbug/cypher-escape.js';
import { isNeo4jBackendEnabled } from '../neo4j/config.js';
import { executeReadCypher } from '../neo4j/read-adapter.js';

const REPO_ID = '__wiki__';

// Dual-backend dispatch state (Ticket 01). The single dispatch basis is
// isNeo4jBackendEnabled(); `wikiRepoId` is written only by initWikiDb and
// gates every Neo4j read so unfiltered whole-graph queries are impossible.
let wikiRepoId: string | undefined;

/** Normalize Neo4j row values: Integer → number, everything else untouched.
 *  The local LadybugDB path never passes through here. */
const normalizeNeo4jRow = (row: Record<string, any>): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value && typeof value.toNumber === 'function' ? value.toNumber() : value;
  }
  return out;
};

/**
 * Run a read query on the active backend: local goes through the lbug pool
 * (existing semantics unchanged); Neo4j goes through executeReadCypher and
 * always attaches the $repoId filter.
 */
const runRead = async (
  localCypher: string,
  neo4jCypher: string,
  params: Record<string, any> = {},
): Promise<Record<string, any>[]> => {
  if (isNeo4jBackendEnabled()) {
    if (!wikiRepoId) {
      throw new Error('Neo4j wiki queries require repoId; call initWikiDb first.');
    }
    const rows = await executeReadCypher(neo4jCypher, { repoId: wikiRepoId, ...params });
    return rows.map(normalizeNeo4jRow);
  }
  return executeQuery(REPO_ID, localCypher);
};

/**
 * Touch the wiki DB connection to prevent idle timeout during long LLM calls.
 * Neo4j mode is a no-op (the driver owns its connection pool; there is no
 * local connection to keep alive).
 */
export function touchWikiDb(): void {
  if (isNeo4jBackendEnabled()) return;
  touchRepo(REPO_ID);
}

/**
 * Keep the wiki DB resident for a full generation run. Wiki generation can spend
 * minutes inside LLM calls, and the pooled DB must survive both idle cleanup and
 * unrelated LRU pressure until the run reaches its final graph queries.
 * Neo4j mode returns a no-op releaser that is safe to call repeatedly.
 */
export function pinWikiDb(): () => void {
  if (isNeo4jBackendEnabled()) return () => {};
  return pinRepo(REPO_ID);
}

export interface FileWithExports {
  filePath: string;
  symbols: Array<{ name: string; type: string }>;
}

export interface CallEdge {
  fromFile: string;
  fromName: string;
  toFile: string;
  toName: string;
}

export interface ProcessInfo {
  id: string;
  label: string;
  type: string;
  stepCount: number;
  steps: Array<{
    step: number;
    name: string;
    filePath: string;
    type: string;
  }>;
}

/**
 * Initialize the wiki graph data source.
 * Local mode: opens LadybugDB (existing semantics unchanged).
 * Neo4j mode: never touches the local lbug file; repoId is required and a
 * missing one fails fast (surfacing as generation_failed) rather than
 * degrading into an unfiltered whole-graph query.
 */
export async function initWikiDb(lbugPath: string, repoId?: string): Promise<void> {
  if (isNeo4jBackendEnabled()) {
    if (!repoId || !repoId.trim()) {
      throw new Error('Neo4j wiki generation requires the repository id (repoId).');
    }
    wikiRepoId = repoId;
    return;
  }
  wikiRepoId = undefined;
  await initLbug(REPO_ID, lbugPath);
}

/**
 * Close the wiki graph data source. Neo4j mode is a no-op (sessions open and
 * close per call).
 */
export async function closeWikiDb(): Promise<void> {
  if (isNeo4jBackendEnabled()) {
    wikiRepoId = undefined;
    return;
  }
  await closeLbug(REPO_ID);
}

/**
 * Get all source files with their exported symbol names and types.
 * Includes top-level exports (File→DEFINES→n) and exported class members
 * (File→DEFINES→Class→HAS_METHOD/HAS_PROPERTY→n) since class members no
 * longer have a direct File→DEFINES edge.
 */
export async function getFilesWithExports(): Promise<FileWithExports[]> {
  const rows = await runRead(
    `
    MATCH (f:File)-[:CodeRelation {type: 'DEFINES'}]->(n)
    WHERE n.isExported = true
    RETURN f.filePath AS filePath, n.name AS name, labels(n)[0] AS type
    UNION
    MATCH (f:File)-[:CodeRelation {type: 'DEFINES'}]->(c)
          -[mr:CodeRelation]->(n)
    WHERE mr.type IN ['HAS_METHOD', 'HAS_PROPERTY'] AND n.isExported = true
    RETURN f.filePath AS filePath, n.name AS name, labels(n)[0] AS type
    ORDER BY filePath
  `,
    `
    MATCH (f:File {repoId: $repoId})-[:DEFINES]->(n {repoId: $repoId})
    WHERE n.isExported = true
    RETURN f.filePath AS filePath, n.name AS name, labels(n)[0] AS type
    UNION
    MATCH (f:File {repoId: $repoId})-[:DEFINES]->(c {repoId: $repoId})
          -[mr:HAS_METHOD|HAS_PROPERTY]->(n {repoId: $repoId})
    WHERE n.isExported = true
    RETURN f.filePath AS filePath, n.name AS name, labels(n)[0] AS type
    ORDER BY filePath
  `,
  );

  const fileMap = new Map<string, FileWithExports>();
  for (const row of rows) {
    const fp = row.filePath || row[0];
    const name = row.name || row[1];
    const type = row.type || row[2];

    let entry = fileMap.get(fp);
    if (!entry) {
      entry = { filePath: fp, symbols: [] };
      fileMap.set(fp, entry);
    }
    entry.symbols.push({ name, type });
  }

  return Array.from(fileMap.values());
}

/**
 * Get all files tracked in the graph (including those with no exports).
 */
export async function getAllFiles(): Promise<string[]> {
  const rows = await runRead(
    `
    MATCH (f:File)
    RETURN f.filePath AS filePath
    ORDER BY f.filePath
  `,
    `
    MATCH (f:File {repoId: $repoId})
    RETURN f.filePath AS filePath
    ORDER BY f.filePath
  `,
  );
  return rows.map((r) => r.filePath || r[0]);
}

/**
 * Get inter-file call edges (calls between different files).
 */
export async function getInterFileCallEdges(): Promise<CallEdge[]> {
  const rows = await runRead(
    `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE a.filePath <> b.filePath
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
  `,
    `
    MATCH (a {repoId: $repoId})-[:CALLS]->(b {repoId: $repoId})
    WHERE a.filePath <> b.filePath
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
  `,
  );

  return rows.map((r) => ({
    fromFile: r.fromFile || r[0],
    fromName: r.fromName || r[1],
    toFile: r.toFile || r[2],
    toName: r.toName || r[3],
  }));
}

/**
 * Get call edges between files within a specific set (intra-module).
 */
export async function getIntraModuleCallEdges(filePaths: string[]): Promise<CallEdge[]> {
  if (filePaths.length === 0) return [];

  const fileList = filePaths.map((f) => `'${escapeCypherString(f)}'`).join(', ');
  const rows = await runRead(
    `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE a.filePath IN [${fileList}] AND b.filePath IN [${fileList}]
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
  `,
    `
    MATCH (a {repoId: $repoId})-[:CALLS]->(b {repoId: $repoId})
    WHERE a.filePath IN $filePaths AND b.filePath IN $filePaths
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
  `,
    { filePaths },
  );

  return rows.map((r) => ({
    fromFile: r.fromFile || r[0],
    fromName: r.fromName || r[1],
    toFile: r.toFile || r[2],
    toName: r.toName || r[3],
  }));
}

/**
 * Get call edges crossing module boundaries (external calls from/to module files).
 */
export async function getInterModuleCallEdges(filePaths: string[]): Promise<{
  outgoing: CallEdge[];
  incoming: CallEdge[];
}> {
  if (filePaths.length === 0) return { outgoing: [], incoming: [] };

  const fileList = filePaths.map((f) => `'${escapeCypherString(f)}'`).join(', ');

  const outRows = await runRead(
    `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE a.filePath IN [${fileList}] AND NOT b.filePath IN [${fileList}]
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
    LIMIT 30
  `,
    `
    MATCH (a {repoId: $repoId})-[:CALLS]->(b {repoId: $repoId})
    WHERE a.filePath IN $filePaths AND NOT b.filePath IN $filePaths
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
    LIMIT 30
  `,
    { filePaths },
  );

  const inRows = await runRead(
    `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE NOT a.filePath IN [${fileList}] AND b.filePath IN [${fileList}]
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
    LIMIT 30
  `,
    `
    MATCH (a {repoId: $repoId})-[:CALLS]->(b {repoId: $repoId})
    WHERE NOT a.filePath IN $filePaths AND b.filePath IN $filePaths
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
    LIMIT 30
  `,
    { filePaths },
  );

  return {
    outgoing: outRows.map((r) => ({
      fromFile: r.fromFile || r[0],
      fromName: r.fromName || r[1],
      toFile: r.toFile || r[2],
      toName: r.toName || r[3],
    })),
    incoming: inRows.map((r) => ({
      fromFile: r.fromFile || r[0],
      fromName: r.fromName || r[1],
      toFile: r.toFile || r[2],
      toName: r.toName || r[3],
    })),
  };
}

/**
 * Get processes (execution flows) that pass through a set of files.
 * Returns top N by step count.
 */
export async function getProcessesForFiles(filePaths: string[], limit = 5): Promise<ProcessInfo[]> {
  if (filePaths.length === 0) return [];

  const fileList = filePaths.map((f) => `'${escapeCypherString(f)}'`).join(', ');

  // Find processes that have steps in the given files
  const procRows = await runRead(
    `
    MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
    WHERE s.filePath IN [${fileList}]
    RETURN DISTINCT p.id AS id, p.heuristicLabel AS label,
           p.processType AS type, p.stepCount AS stepCount
    ORDER BY stepCount DESC
    LIMIT ${limit}
  `,
    `
    MATCH (s {repoId: $repoId})-[:STEP_IN_PROCESS]->(p:Process {repoId: $repoId})
    WHERE s.filePath IN $filePaths
    RETURN DISTINCT p.id AS id, p.heuristicLabel AS label,
           p.processType AS type, p.stepCount AS stepCount
    ORDER BY stepCount DESC
    LIMIT $limit
  `,
    { filePaths, limit },
  );

  const processes: ProcessInfo[] = [];
  for (const row of procRows) {
    const procId = row.id || row[0];
    const label = row.label || row[1] || procId;
    const type = row.type || row[2] || 'unknown';
    const stepCount = row.stepCount || row[3] || 0;

    // Get the full step trace for this process
    const stepRows = await runRead(
      `
      MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: '${escapeCypherString(procId)}'})
      RETURN s.name AS name, s.filePath AS filePath, labels(s)[0] AS type, r.step AS step
      ORDER BY r.step
    `,
      `
      MATCH (s {repoId: $repoId})-[r:STEP_IN_PROCESS]->(p:Process {repoId: $repoId, id: $procId})
      RETURN s.name AS name, s.filePath AS filePath, labels(s)[0] AS type, r.step AS step
      ORDER BY r.step
    `,
      { procId },
    );

    processes.push({
      id: procId,
      label,
      type,
      stepCount,
      steps: stepRows.map((s) => ({
        step: s.step || s[3] || 0,
        name: s.name || s[0],
        filePath: s.filePath || s[1],
        type: s.type || s[2],
      })),
    });
  }

  return processes;
}

/**
 * Get all processes in the graph (for overview page).
 */
export async function getAllProcesses(limit = 20): Promise<ProcessInfo[]> {
  const procRows = await runRead(
    `
    MATCH (p:Process)
    RETURN p.id AS id, p.heuristicLabel AS label,
           p.processType AS type, p.stepCount AS stepCount
    ORDER BY stepCount DESC
    LIMIT ${limit}
  `,
    `
    MATCH (p:Process {repoId: $repoId})
    RETURN p.id AS id, p.heuristicLabel AS label,
           p.processType AS type, p.stepCount AS stepCount
    ORDER BY stepCount DESC
    LIMIT $limit
  `,
    { limit },
  );

  const processes: ProcessInfo[] = [];
  for (const row of procRows) {
    const procId = row.id || row[0];
    const label = row.label || row[1] || procId;
    const type = row.type || row[2] || 'unknown';
    const stepCount = row.stepCount || row[3] || 0;

    const stepRows = await runRead(
      `
      MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: '${escapeCypherString(procId)}'})
      RETURN s.name AS name, s.filePath AS filePath, labels(s)[0] AS type, r.step AS step
      ORDER BY r.step
    `,
      `
      MATCH (s {repoId: $repoId})-[r:STEP_IN_PROCESS]->(p:Process {repoId: $repoId, id: $procId})
      RETURN s.name AS name, s.filePath AS filePath, labels(s)[0] AS type, r.step AS step
      ORDER BY r.step
    `,
      { procId },
    );

    processes.push({
      id: procId,
      label,
      type,
      stepCount,
      steps: stepRows.map((s) => ({
        step: s.step || s[3] || 0,
        name: s.name || s[0],
        filePath: s.filePath || s[1],
        type: s.type || s[2],
      })),
    });
  }

  return processes;
}

/**
 * Get inter-module edges for overview architecture diagram.
 * Groups call edges by source/target module.
 */
export async function getInterModuleEdgesForOverview(
  moduleFiles: Record<string, string[]>,
): Promise<Array<{ from: string; to: string; count: number }>> {
  // Build file-to-module lookup
  const fileToModule = new Map<string, string>();
  for (const [mod, files] of Object.entries(moduleFiles)) {
    for (const f of files) {
      fileToModule.set(f, mod);
    }
  }

  const allEdges = await getInterFileCallEdges();
  const moduleEdgeCounts = new Map<string, number>();

  for (const edge of allEdges) {
    const fromMod = fileToModule.get(edge.fromFile);
    const toMod = fileToModule.get(edge.toFile);
    if (fromMod && toMod && fromMod !== toMod) {
      const key = `${fromMod}|||${toMod}`;
      moduleEdgeCounts.set(key, (moduleEdgeCounts.get(key) || 0) + 1);
    }
  }

  return Array.from(moduleEdgeCounts.entries())
    .map(([key, count]) => {
      const [from, to] = key.split('|||');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);
}
