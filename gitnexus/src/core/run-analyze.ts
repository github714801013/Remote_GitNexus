/**
 * Shared Analysis Orchestrator
 *
 * Extracts the core analysis pipeline from the CLI analyze command into a
 * reusable function that can be called from both the CLI and a server-side
 * worker process.
 *
 * IMPORTANT: This module must NEVER call process.exit(). The caller (CLI
 * wrapper or server worker) is responsible for process lifecycle.
 */

import path from 'path';
import fs from 'fs/promises';
import { runPipelineFromRepo } from './ingestion/pipeline.js';
import {
  initLbug,
  loadGraphToLbug,
  getLbugStats,
  executeQuery,
  executeWithReusedStatement,
  ensureFTSIndex,
  closeLbug,
  loadCachedEmbeddings,
  fetchExistingEmbeddingHashes,
} from './lbug/lbug-adapter.js';
import {
  getStoragePaths,
  saveMeta,
  loadMeta,
  addToGitignore,
  registerRepo,
  cleanupOldKuzuFiles,
} from '../storage/repo-manager.js';
import {
  getCurrentCommit,
  getCurrentBranch,
  getRemoteUrl,
  hasGitDir,
  getInferredRepoName,
} from '../storage/git.js';
import type { CachedEmbedding } from './embeddings/types.js';
import { generateAIContextFiles } from '../cli/ai-context.js';
import { EMBEDDING_TABLE_NAME } from './lbug/schema.js';
import { STALE_HASH_SENTINEL } from './lbug/schema.js';
import { FTS_INDEXES } from './search/bm25-index.js';
import {
  backupLatestIndex,
  prepareEmbeddingShadowIndex,
  probeLbugFile,
  swapEmbeddingShadowToLive,
} from './lbug/index-backup.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnalyzeCallbacks {
  onProgress: (phase: string, percent: number, message: string) => void;
  onLog?: (message: string) => void;
}

export interface AnalyzeOptions {
  /**
   * Force a full re-index of the pipeline. Callers may OR this with
   * other flags that imply re-analysis (e.g. `--skills`), so the value
   * here is the PIPELINE-force signal, NOT the registry-collision
   * bypass. See `allowDuplicateName` below.
   */
  force?: boolean;
  embeddings?: boolean;
  skipGit?: boolean;
  /** Skip AGENTS.md and CLAUDE.md gitnexus block updates. */
  skipAgentsMd?: boolean;
  /** Omit volatile symbol/relationship counts from AGENTS.md and CLAUDE.md. */
  noStats?: boolean;
  /**
   * User-provided alias for the registry `name` (#829). When set,
   * forwarded to `registerRepo` so the indexed repo is stored under
   * this alias instead of the path-derived basename.
   */
  registryName?: string;
  /**
   * Branch name to persist in meta/registry when the on-disk git branch is an
   * implementation detail, e.g. env worktrees named dev-project.
   */
  registryBranch?: string;
  /**
   * Bypass the `RegistryNameCollisionError` guard and allow two paths
   * to register under the same `name` (#829). Controlled by the
   * dedicated `--allow-duplicate-name` CLI flag, intentionally
   * independent from `--force` — users who hit the collision guard
   * should be able to accept the duplicate without paying the cost
   * of a pipeline re-index.
   */
  allowDuplicateName?: boolean;
  /** Return raw pipeline artifacts for CLI-only post-processing such as skill generation. */
  returnPipelineResult?: boolean;
}

export interface EmbeddingsOnlyOptions {
  registryName?: string;
}

export interface AnalyzeResult {
  repoName: string;
  repoPath: string;
  stats: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
    embeddings?: number;
  };
  alreadyUpToDate?: boolean;
  /** The raw pipeline result — only populated when needed by callers (e.g. skill generation). */
  pipelineResult?: any;
}

type ExistingAnalyzeMeta = {
  lastCommit?: string;
  branch?: string;
  stats?: {
    embeddings?: number;
  };
};

export function shouldReturnAlreadyUpToDate(
  existingMeta: ExistingAnalyzeMeta | null | undefined,
  currentCommit: string,
  options: Pick<AnalyzeOptions, 'force' | 'embeddings' | 'registryBranch'>,
): boolean {
  if (!existingMeta || options.force || existingMeta.lastCommit !== currentCommit) {
    return false;
  }
  if (options.registryBranch && existingMeta.branch !== options.registryBranch) {
    return false;
  }
  if (currentCommit === '') {
    return false;
  }
  if (options.embeddings && (existingMeta.stats?.embeddings ?? 0) <= 0) {
    return false;
  }
  return true;
}

export function shouldGenerateEmbeddingsForAnalysis(
  existingMeta: ExistingAnalyzeMeta | null | undefined,
  options: Pick<AnalyzeOptions, 'embeddings'>,
): boolean {
  return options.embeddings ?? (existingMeta?.stats?.embeddings ?? 0) > 0;
}

/** Threshold: auto-skip embeddings for repos with more nodes than this */
const EMBEDDING_NODE_LIMIT = process.env.GITNEXUS_EMBEDDING_LIMIT
  ? parseInt(process.env.GITNEXUS_EMBEDDING_LIMIT, 10)
  : 200_000;

export const PHASE_LABELS: Record<string, string> = {
  extracting: 'Scanning files',
  structure: 'Building structure',
  parsing: 'Parsing code',
  imports: 'Resolving imports',
  calls: 'Tracing calls',
  heritage: 'Extracting inheritance',
  communities: 'Detecting communities',
  processes: 'Detecting processes',
  complete: 'Pipeline complete',
  lbug: 'Loading into LadybugDB',
  fts: 'Creating search indexes',
  embeddings: 'Generating embeddings',
  done: 'Done',
};

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full GitNexus analysis pipeline.
 *
 * This is the shared core extracted from the CLI `analyze` command. It
 * handles: pipeline execution, LadybugDB loading, FTS indexing, embedding
 * generation, metadata persistence, and AI context file generation.
 *
 * The function communicates progress and log messages exclusively through
 * the {@link AnalyzeCallbacks} interface — it never writes to stdout/stderr
 * directly and never calls `process.exit()`.
 */
export async function runFullAnalysis(
  repoPath: string,
  options: AnalyzeOptions,
  callbacks: AnalyzeCallbacks,
): Promise<AnalyzeResult> {
  const log = (msg: string) => callbacks.onLog?.(msg);
  const progress = (phase: string, percent: number, message: string) =>
    callbacks.onProgress(phase, percent, message);

  const { storagePath, lbugPath } = getStoragePaths(repoPath);
  const lbugShadowPath = `${lbugPath}.shadow`;

  // Clean up stale KuzuDB files from before the LadybugDB migration.
  const kuzuResult = await cleanupOldKuzuFiles(storagePath);
  if (kuzuResult.found && kuzuResult.needsReindex) {
    log('Migrating from KuzuDB to LadybugDB — rebuilding index...');
  }

  const repoHasGit = hasGitDir(repoPath);
  const currentCommit = repoHasGit ? getCurrentCommit(repoPath) : '';
  const existingMeta = await loadMeta(storagePath);
  const shouldGenerateEmbeddings = shouldGenerateEmbeddingsForAnalysis(existingMeta, options);
  const projectNameInitial =
    options.registryName ?? getInferredRepoName(repoPath) ?? path.basename(repoPath);
  const { isNeo4jBackendEnabled } = await import('./neo4j/config.js');
  const neo4jBackendEnabled = isNeo4jBackendEnabled();
  let canReturnAlreadyUpToDate = true;
  if (neo4jBackendEnabled) {
    try {
      const { countRepoGraphNodes } = await import('./neo4j/graph-loader.js');
      canReturnAlreadyUpToDate = (await countRepoGraphNodes(projectNameInitial)) > 0;
    } catch {
      canReturnAlreadyUpToDate = false;
    }
  }

  // ── Early-return: already up to date ──────────────────────────────
  if (
    canReturnAlreadyUpToDate &&
    shouldReturnAlreadyUpToDate(existingMeta, currentCommit, {
      ...options,
      embeddings: shouldGenerateEmbeddings,
    })
  ) {
    return {
      repoName: options.registryName ?? getInferredRepoName(repoPath) ?? path.basename(repoPath),
      repoPath,
      stats: existingMeta?.stats ?? {},
      alreadyUpToDate: true,
    };
  }

  // ── Cache embeddings from existing index before rebuild ────────────
  let cachedEmbeddingNodeIds = new Set<string>();
  let cachedEmbeddings: CachedEmbedding[] = [];

  if (shouldGenerateEmbeddings && existingMeta) {
    try {
      progress('embeddings', 0, 'Caching embeddings...');
      await initLbug(lbugPath);
      const cached = await loadCachedEmbeddings();
      cachedEmbeddingNodeIds = cached.embeddingNodeIds;
      cachedEmbeddings = cached.embeddings;
      await closeLbug();
    } catch {
      try {
        await closeLbug();
      } catch {
        /* swallow */
      }
    }
  }

  // ── Phase 1: Full Pipeline (0–60%) ────────────────────────────────
  const pipelineResult = await runPipelineFromRepo(repoPath, (p) => {
    const phaseLabel = PHASE_LABELS[p.phase] || p.phase;
    const scaled = Math.round(p.percent * 0.6);
    progress(p.phase, scaled, p.message.startsWith('[memory] ') ? p.message : phaseLabel);
  });

  if (neo4jBackendEnabled) {
    progress('lbug', 60, 'Loading into Neo4j...');
    const { loadGraphToNeo4j } = await import('./neo4j/graph-loader.js');
    const stats = await loadGraphToNeo4j(projectNameInitial, pipelineResult.graph);
    const graphMeta = {
      repoPath,
      lastCommit: currentCommit,
      indexedAt: new Date().toISOString(),
      branch:
        options.registryBranch ?? (hasGitDir(repoPath) ? getCurrentBranch(repoPath) : undefined),
      remoteUrl: hasGitDir(repoPath) ? getRemoteUrl(repoPath) : undefined,
      stats: {
        files: pipelineResult.totalFileCount,
        nodes: stats.nodes,
        edges: stats.edges,
        communities: pipelineResult.communityResult?.stats.totalCommunities,
        processes: pipelineResult.processResult?.stats.totalProcesses,
        embeddings: 0,
      },
    };

    progress('done', 89, 'Saving graph metadata...');
    const projectName = await registerRepo(repoPath, graphMeta, {
      name: options.registryName,
      allowDuplicateName: options.allowDuplicateName,
    });
    await saveMeta(storagePath, graphMeta);
    let finalMeta = graphMeta;

    if (shouldGenerateEmbeddings && stats.nodes <= EMBEDDING_NODE_LIMIT) {
      const { isHttpMode } = await import('./embeddings/http-client.js');
      const httpMode = isHttpMode();
      progress(
        'embeddings',
        90,
        httpMode ? 'Connecting to embedding endpoint...' : 'Loading embedding model...',
      );

      const { runEmbeddingPipeline } = await import('./embeddings/embedding-pipeline.js');
      const {
        countEmbeddings,
        deleteEmbeddingsForNodes,
        ensureNeo4jEmbeddingIndex,
        fetchExistingEmbeddingHashes: fetchExistingNeo4jEmbeddingHashes,
        loadEmbeddableNodes,
        upsertEmbeddings,
      } = await import('./neo4j/embedding-adapter.js');
      const { readServerMapping } = await import('./embeddings/server-mapping.js');
      const serverName = await readServerMapping(projectNameInitial);
      const existingEmbeddings = await fetchExistingNeo4jEmbeddingHashes(projectNameInitial);

      await runEmbeddingPipeline(
        async () => [],
        async () => {},
        (p) => {
          const scaled = 90 + Math.round((p.percent / 100) * 8);
          const label =
            p.phase === 'loading-model'
              ? httpMode
                ? 'Connecting to embedding endpoint...'
                : 'Loading embedding model...'
              : `Embedding ${p.nodesProcessed || 0}/${p.totalNodes || '?'}`;
          progress('embeddings', scaled, label);
        },
        {},
        undefined,
        { repoName: projectNameInitial, serverName },
        existingEmbeddings,
        {
          loadNodes: () => loadEmbeddableNodes(projectNameInitial),
          insertEmbeddings: (updates) => upsertEmbeddings(projectNameInitial, updates),
          deleteEmbeddingsForNodeIds: (nodeIds) =>
            deleteEmbeddingsForNodes(projectNameInitial, nodeIds),
          ensureVectorIndex: ensureNeo4jEmbeddingIndex,
        },
      );

      finalMeta = {
        ...graphMeta,
        indexedAt: new Date().toISOString(),
        stats: {
          ...graphMeta.stats,
          embeddings: await countEmbeddings(projectNameInitial),
        },
      };
    }

    progress('done', 98, 'Saving metadata...');
    await registerRepo(repoPath, finalMeta, {
      name: options.registryName,
      allowDuplicateName: options.allowDuplicateName,
    });
    await saveMeta(storagePath, finalMeta);
    if (hasGitDir(repoPath)) {
      await addToGitignore(repoPath);
    }

    progress('done', 100, 'Done');
    return {
      repoName: projectName,
      repoPath,
      stats: finalMeta.stats,
      ...(options.returnPipelineResult ? { pipelineResult } : {}),
    };
  }

  // ── Phase 2: LadybugDB (60–85%) ──────────────────────────────────
  progress('lbug', 60, 'Loading into LadybugDB (Shadow Build)...');

  await closeLbug();
  // Clear any existing shadow files
  const shadowFiles = [lbugShadowPath, `${lbugShadowPath}.wal`, `${lbugShadowPath}.lock`];
  for (const f of shadowFiles) {
    try {
      await fs.rm(f, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }

  // BUILD IN SHADOW
  await initLbug(lbugShadowPath);
  try {
    // All work after initLbug is wrapped in try/finally to ensure closeLbug()
    // is called even if an error occurs — the module-level singleton DB handle
    // must be released to avoid blocking subsequent invocations.

    let lbugMsgCount = 0;
    await loadGraphToLbug(pipelineResult.graph, pipelineResult.repoPath, storagePath, (msg) => {
      lbugMsgCount++;
      const pct = Math.min(84, 60 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 24));
      progress('lbug', pct, msg);
    });

    // ── Phase 3: FTS (85–90%) ─────────────────────────────────────────
    progress('fts', 85, 'Creating search indexes...');
    // 在 shadow DB 上提前创建 FTS，swap 后 live 文件天然带索引；
    // 查询进程只读 live，避免首次查询时 CREATE_FTS_INDEX 触发 checkpoint 锁等待。
    for (const { table, indexName, properties } of FTS_INDEXES) {
      await ensureFTSIndex(table, indexName, [...properties], 'none');
    }

    // ── Phase 3.5: Re-insert cached embeddings ────────────────────────
    if (cachedEmbeddings.length > 0) {
      const cachedDims = cachedEmbeddings[0].embedding.length;
      const { EMBEDDING_DIMS } = await import('./lbug/schema.js');
      if (cachedDims !== EMBEDDING_DIMS) {
        // Dimensions changed (e.g. switched embedding model) — discard cache and re-embed all
        log(
          `Embedding dimensions changed (${cachedDims}d -> ${EMBEDDING_DIMS}d), discarding cache`,
        );
        cachedEmbeddings = [];
        cachedEmbeddingNodeIds = new Set();
      } else {
        progress('embeddings', 88, `Restoring ${cachedEmbeddings.length} cached embeddings...`);
        const { batchInsertEmbeddings: batchInsert } =
          await import('./embeddings/embedding-pipeline.js');
        const EMBED_BATCH = 200;
        for (let i = 0; i < cachedEmbeddings.length; i += EMBED_BATCH) {
          const batch = cachedEmbeddings.slice(i, i + EMBED_BATCH);

          try {
            await batchInsert(executeWithReusedStatement, batch);
          } catch {
            /* some may fail if node was removed, that's fine */
          }
        }
      }
    }

    // ── Phase 4: Embeddings (90–98%) ──────────────────────────────────
    const stats = await getLbugStats();
    let embeddingSkipped = true;

    if (shouldGenerateEmbeddings) {
      if (stats.nodes <= EMBEDDING_NODE_LIMIT) {
        embeddingSkipped = false;
      }
    }

    if (!embeddingSkipped) {
      const { isHttpMode } = await import('./embeddings/http-client.js');
      const httpMode = isHttpMode();
      progress(
        'embeddings',
        90,
        httpMode ? 'Connecting to embedding endpoint...' : 'Loading embedding model...',
      );
      const { runEmbeddingPipeline } = await import('./embeddings/embedding-pipeline.js');
      // Build a Map<nodeId, contentHash> from cached embeddings for incremental mode
      let existingEmbeddings: Map<string, string> | undefined;
      if (cachedEmbeddingNodeIds.size > 0) {
        existingEmbeddings = new Map<string, string>();
        for (const e of cachedEmbeddings) {
          existingEmbeddings.set(e.nodeId, e.contentHash ?? STALE_HASH_SENTINEL);
        }
      }

      const { readServerMapping } = await import('./embeddings/server-mapping.js');
      const projectName = path.basename(repoPath);
      const serverName = await readServerMapping(projectName);
      await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        (p) => {
          const scaled = 90 + Math.round((p.percent / 100) * 8);
          const label =
            p.phase === 'loading-model'
              ? httpMode
                ? 'Connecting to embedding endpoint...'
                : 'Loading embedding model...'
              : `Embedding ${p.nodesProcessed || 0}/${p.totalNodes || '?'}`;
          progress('embeddings', scaled, label);
        },
        {},
        cachedEmbeddingNodeIds.size > 0 ? cachedEmbeddingNodeIds : undefined,
        { repoName: projectName, serverName },
        existingEmbeddings,
      );
    }

    // ── Phase 5: Finalize (98–100%) ───────────────────────────────────
    progress('done', 98, 'Saving metadata...');
    // Count embeddings in the index (cached + newly generated)
    let embeddingCount = 0;
    try {
      const embResult = await executeQuery(
        `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS cnt`,
      );
      embeddingCount = embResult?.[0]?.cnt ?? 0;
    } catch {
      /* table may not exist if embeddings never ran */
    }

    const meta = {
      repoPath,
      lastCommit: currentCommit,
      indexedAt: new Date().toISOString(),
      branch:
        options.registryBranch ?? (hasGitDir(repoPath) ? getCurrentBranch(repoPath) : undefined),
      // Captured here (not at registration) so it travels with the
      // on-disk meta.json — sibling-clone fingerprinting works for
      // out-of-tree consumers (group-status, future tooling) without
      // a second git shellout. `undefined` when the repo has no
      // origin remote, which is fine: paths-only repos behave as
      // before.
      remoteUrl: hasGitDir(repoPath) ? getRemoteUrl(repoPath) : undefined,
      stats: {
        files: pipelineResult.totalFileCount,
        nodes: stats.nodes,
        edges: stats.edges,
        communities: pipelineResult.communityResult?.stats.totalCommunities,
        processes: pipelineResult.processResult?.stats.totalProcesses,
        embeddings: embeddingCount,
      },
    };
    let projectName =
      options.registryName ?? getInferredRepoName(repoPath) ?? path.basename(repoPath);

    // ── Generate AI context files (best-effort) ───────────────────────
    let aggregatedClusterCount = 0;
    if (pipelineResult.communityResult?.communities) {
      const groups = new Map<string, number>();
      for (const c of pipelineResult.communityResult.communities) {
        const label = c.heuristicLabel || c.label || 'Unknown';
        groups.set(label, (groups.get(label) || 0) + c.symbolCount);
      }
      aggregatedClusterCount = Array.from(groups.values()).filter((count) => count >= 5).length;
    }

    try {
      await generateAIContextFiles(
        repoPath,
        storagePath,
        projectName,
        {
          files: pipelineResult.totalFileCount,
          nodes: stats.nodes,
          edges: stats.edges,
          communities: pipelineResult.communityResult?.stats.totalCommunities,
          clusters: aggregatedClusterCount,
          processes: pipelineResult.processResult?.stats.totalProcesses,
        },
        undefined,
        { skipAgentsMd: options.skipAgentsMd, noStats: options.noStats },
      );
    } catch {
      // Best-effort — don't fail the entire analysis for context file issues
    }

    // ── Close LadybugDB ──────────────────────────────────────────────
    await closeLbug();

    // ── Phase 4: Atomic Swap ──────────────────────────────────────────
    progress('lbug', 98, 'Finalizing index (Atomic Swap)...');

    const liveFiles = [lbugPath, `${lbugPath}.wal`, `${lbugPath}.lock`];
    const shadowFiles = [lbugShadowPath, `${lbugShadowPath}.wal`];

    const shadowProbe = await probeLbugFile(lbugShadowPath);
    if (!shadowProbe.ok) {
      throw new Error(
        `Shadow LadybugDB integrity check failed: ${shadowProbe.error ?? 'unknown error'}`,
      );
    }

    const backupResult = await backupLatestIndex({
      lbugPath,
      metaPath: path.join(storagePath, 'meta.json'),
      repoPath,
    });
    if (backupResult.status === 'created') {
      log(`[analyze] Backed up previous live index for ${projectName}`);
    } else if (backupResult.status === 'skipped-invalid-live') {
      log(`[analyze] Previous live index was invalid; keeping existing backup for ${projectName}`);
    }

    // 1. Remove old live files
    for (const f of liveFiles) {
      try {
        await fs.rm(f, { force: true, recursive: true });
      } catch {
        /* swallow */
      }
    }

    // 2. Move shadow to live
    if (
      await fs
        .stat(lbugShadowPath)
        .then(() => true)
        .catch(() => false)
    ) {
      await fs.rename(lbugShadowPath, lbugPath);
    }
    if (
      await fs
        .stat(`${lbugShadowPath}.wal`)
        .then(() => true)
        .catch(() => false)
    ) {
      await fs.rename(`${lbugShadowPath}.wal`, `${lbugPath}.wal`);
    }

    log(`[analyze] Successfully swapped shadow index to live for ${projectName}`);

    await saveMeta(storagePath, meta);
    // Forward the --name alias and the registry-collision bypass bit.
    // `allowDuplicateName` is its own concern — independent from the
    // pipeline `force` above. The CLI maps it from
    // `--allow-duplicate-name` only; `--force` and `--skills` both
    // trigger pipeline re-run but never bypass the registry guard.
    // The returned name is the one actually written to the registry
    // (after applying the precedence chain in registerRepo) — reuse it
    // so AGENTS.md / skill files reference the same name MCP clients
    // will look up (#979).
    projectName = await registerRepo(repoPath, meta, {
      name: options.registryName,
      allowDuplicateName: options.allowDuplicateName,
    });

    // Only attempt to update .gitignore when a .git directory is present.
    if (hasGitDir(repoPath)) {
      await addToGitignore(repoPath);
    }

    progress('done', 100, 'Done');

    return {
      repoName: projectName,
      repoPath,
      stats: meta.stats,
      ...(options.returnPipelineResult ? { pipelineResult } : {}),
    };
  } catch (err) {
    // Ensure LadybugDB is closed even on error
    try {
      await closeLbug();
    } catch {
      /* swallow */
    }
    throw err;
  }
}

export async function runEmbeddingsOnly(
  repoPath: string,
  options: EmbeddingsOnlyOptions,
  callbacks: AnalyzeCallbacks,
): Promise<AnalyzeResult> {
  const log = (msg: string) => callbacks.onLog?.(msg);
  const progress = (phase: string, percent: number, message: string) =>
    callbacks.onProgress(phase, percent, message);

  const { storagePath, lbugPath } = getStoragePaths(repoPath);
  const metaPath = path.join(storagePath, 'meta.json');
  const shadowLbugPath = `${lbugPath}.embedding-shadow`;
  const shadowMetaPath = `${metaPath}.embedding-shadow`;
  const projectName =
    options.registryName ?? getInferredRepoName(repoPath) ?? path.basename(repoPath);
  const existingMeta = await loadMeta(storagePath);
  if (!existingMeta) {
    throw new Error('No existing GitNexus index found. Run `gitnexus analyze` first.');
  }

  progress('lbug', 0, 'Preparing embedding shadow index...');
  const liveProbe = await probeLbugFile(lbugPath);
  if (!liveProbe.ok) {
    throw new Error(
      `Live LadybugDB integrity check failed before embeddings: ${liveProbe.error ?? 'unknown error'}`,
    );
  }

  await prepareEmbeddingShadowIndex(lbugPath, metaPath, { shadowLbugPath, shadowMetaPath });

  const shadowProbe = await probeLbugFile(shadowLbugPath);
  if (!shadowProbe.ok) {
    throw new Error(
      `Embedding shadow LadybugDB integrity check failed: ${shadowProbe.error ?? 'unknown error'}`,
    );
  }

  progress('lbug', 5, 'Opening embedding shadow index...');
  await initLbug(shadowLbugPath);
  try {
    const existingEmbeddings = await fetchExistingEmbeddingHashes(executeQuery);
    if (existingEmbeddings && existingEmbeddings.size > 0) {
      log(`Incremental embeddings: ${existingEmbeddings.size} existing node(s)`);
    }

    const { readServerMapping } = await import('./embeddings/server-mapping.js');
    const { runEmbeddingPipeline } = await import('./embeddings/embedding-pipeline.js');
    const serverName = await readServerMapping(projectName);
    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      (p) => {
        const label =
          p.phase === 'loading-model'
            ? 'Loading embedding model...'
            : p.phase === 'embedding'
              ? `Embedding ${p.nodesProcessed || 0}/${p.totalNodes || '?'}`
              : p.phase === 'indexing'
                ? 'Creating vector index...'
                : p.phase === 'ready'
                  ? 'Embeddings complete'
                  : p.phase;
        progress(p.phase, p.percent, label);
      },
      {},
      undefined,
      { repoName: projectName, serverName },
      existingEmbeddings,
    );

    let embeddingCount = 0;
    try {
      const embResult = await executeQuery(
        `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS cnt`,
      );
      embeddingCount = embResult?.[0]?.cnt ?? 0;
    } catch {
      /* table may not exist if embeddings never ran */
    }

    const stats = await getLbugStats();
    const updatedMeta = {
      ...existingMeta,
      indexedAt: new Date().toISOString(),
      stats: {
        ...existingMeta.stats,
        nodes: stats.nodes || existingMeta.stats?.nodes,
        edges: stats.edges || existingMeta.stats?.edges,
        embeddings: embeddingCount,
      },
    };

    await fs.writeFile(shadowMetaPath, JSON.stringify(updatedMeta, null, 2), 'utf-8');
    await closeLbug();

    const completedShadowProbe = await probeLbugFile(shadowLbugPath);
    if (!completedShadowProbe.ok) {
      throw new Error(
        `Completed embedding shadow integrity check failed: ${completedShadowProbe.error ?? 'unknown error'}`,
      );
    }

    const backupResult = await backupLatestIndex({
      lbugPath,
      metaPath,
      repoPath,
    });
    if (backupResult.status === 'created') {
      log(`[embeddings] Backed up previous live index for ${projectName}`);
    } else if (backupResult.status === 'skipped-invalid-live') {
      log(
        `[embeddings] Previous live index was invalid; keeping existing backup for ${projectName}`,
      );
    }

    progress('lbug', 99, 'Swapping embedding shadow index to live...');
    await swapEmbeddingShadowToLive(lbugPath, metaPath, { shadowLbugPath, shadowMetaPath });

    const repoName = await registerRepo(repoPath, updatedMeta, { name: options.registryName });
    progress('done', 100, 'Done');
    return {
      repoName,
      repoPath,
      stats: updatedMeta.stats,
    };
  } finally {
    try {
      await closeLbug();
    } catch {
      /* swallow */
    }
  }
}
