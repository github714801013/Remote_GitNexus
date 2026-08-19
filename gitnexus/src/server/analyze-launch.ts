/**
 * Shared analyze-worker launcher.
 *
 * Forks the analyze worker for an already-resolved repo directory and owns the
 * lock + auto-retry + IPC machinery. Used by both the JSON `/api/analyze` route
 * and the multipart `/api/analyze/upload` route. Dependency-injected (like
 * createAnalyzeUploadHandler) so the seam is testable and api.ts stays smaller.
 *
 * NOTE: this module must live alongside analyze-worker.{ts,js} — the worker
 * path is resolved relative to `import.meta.url`.
 */

import path from 'path';
import { existsSync, statSync } from 'node:fs';
import { fork } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'node:module';
import {
  canonicalizePath,
  getStoragePath,
  INDEX_METADATA_FILE,
  listRegisteredRepos,
  registryPathEquals,
} from '../storage/repo-manager.js';
import { logger } from '../core/logger.js';
import { autoHeapCapMb } from '../core/ingestion/utils/effective-ram.js';
import type { JobManager } from './analyze-job.js';
import type { WorkerMessage } from './analyze-worker.js';
import type { AnalyzeResultIpc } from './analyze-worker-ipc.js';
import { buildAnalyzeWorkerExecArgv } from './analyze-worker-options.js';
import { isNeo4jBackendEnabled } from '../core/neo4j/config.js';

const _require = createRequire(import.meta.url);

export interface LaunchDeps {
  jobManager: JobManager;
  backend: { init: () => Promise<unknown> };
  acquireRepoLock: (key: string) => string | null;
  releaseRepoLock: (key: string) => void;
  /**
   * Drops the server's cached LadybugDB handle (closeLbug). The worker
   * process rewrites the repo's DB files on disk, so a connection opened
   * before the rewrite keeps reading the pre-rewrite state until evicted.
   */
  closeDbHandle: () => Promise<void>;
  /** Schedules server-owned work only after structural finalization is observable. */
  onAnalysisFinalized?: (
    result: AnalyzeResultIpc,
    context: { jobId: string; repoPath: string },
  ) => void;
}

export interface LaunchOptions {
  force?: boolean;
  embeddings?: boolean;
  dropEmbeddings?: boolean;
  deferEmbeddingRepair?: boolean;
  registryName?: string;
  registryBranch?: string;
  allowDuplicateName?: boolean;
  lockAlreadyHeld?: boolean;
}

const MAX_WORKER_RETRIES = 2;
const MAX_WORKER_STDERR_CHARS = 4096;
const STDERR_TRUNCATION_MARKER = '[stderr truncated] ';

function appendWorkerStderr(current: string, chunk: unknown): string {
  const text = Buffer.isBuffer(chunk)
    ? chunk.toString('utf8')
    : typeof chunk === 'string'
      ? chunk
      : String(chunk ?? '');
  if (!text) return current;

  const withoutMarker = current.startsWith(STDERR_TRUNCATION_MARKER)
    ? current.slice(STDERR_TRUNCATION_MARKER.length)
    : current;
  const next = withoutMarker + text;
  if (next.length <= MAX_WORKER_STDERR_CHARS) return next;

  const available = MAX_WORKER_STDERR_CHARS - STDERR_TRUNCATION_MARKER.length;
  let tail = next.slice(-available);
  if (tail.length > 0 && /[\uDC00-\uDFFF]/u.test(tail[0])) tail = tail.slice(1);
  return STDERR_TRUNCATION_MARKER + tail;
}

function workerStderrDiagnostic(stderr: string): string {
  return stderr.trim();
}

/**
 * The worker reports `complete` over IPC before its on-disk finalization
 * (LadybugDB checkpoint + native handle release + metadata write) is visible
 * at `getStoragePath(targetPath)` — observed up to ~6.5s behind the IPC
 * message. Opening the database inside that window is what the pre-IPC
 * ordering was meant to prevent and is actively dangerous: reads fail with
 * binder errors or return an empty graph, the open can quarantine the
 * in-flight WAL, and the native layer racing the rewrite has crashed the
 * whole server (SIGSEGV-class exit, no output) on slow CI runners.
 */
const FINALIZE_SETTLE_TIMEOUT_MS = 60_000;
const FINALIZE_SETTLE_POLL_MS = 200;

/**
 * Resolve once the analyzed repo's index is settled at `storagePath`: the
 * LadybugDB file and metadata both exist AND were (re)written by THIS job
 * (mtime >= jobStartMs — bare existence is not enough, a re-analysis leaves
 * the previous index in place while it works), and no transient WAL/shadow/
 * checkpoint sidecars remain (the worker's native close has finished).
 *
 * Never rejects. Timing out logs and proceeds (pre-gate behavior) rather
 * than failing a job whose analysis genuinely succeeded — e.g. a no-op
 * non-force analyze legitimately rewrites nothing.
 */
/**
 * Look up the analyzed repo's registered storage path. The request's
 * user-provided path is used only as a comparison key; the filesystem probes
 * below run against the registry's own `storagePath` — the server-owned
 * record readers resolve through, and not a user-controlled value
 * (CodeQL js/path-injection).
 */
const registeredStoragePath = async (targetPath: string): Promise<string | null> => {
  const target = canonicalizePath(path.resolve(targetPath));
  const entries = await listRegisteredRepos();
  const entry = entries.find((e) => registryPathEquals(canonicalizePath(e.path), target));
  return entry?.storagePath ?? null;
};

const waitForSettledIndex = async (targetPath: string, jobStartMs: number): Promise<void> => {
  const settled = (storagePath: string): boolean => {
    try {
      const lbugStat = statSync(path.join(storagePath, 'lbug'));
      const metaStat = statSync(path.join(storagePath, INDEX_METADATA_FILE));
      return (
        lbugStat.mtimeMs >= jobStartMs &&
        metaStat.mtimeMs >= jobStartMs &&
        ['lbug.wal', 'lbug.shadow', 'lbug.wal.checkpoint'].every(
          (f) => !existsSync(path.join(storagePath, f)),
        )
      );
    } catch {
      return false; // not written yet
    }
  };
  const deadline = Date.now() + FINALIZE_SETTLE_TIMEOUT_MS;
  for (;;) {
    // Re-resolved each round: the worker registers the repo as part of the
    // finalization this gate is waiting out.
    const storagePath = await registeredStoragePath(targetPath);
    if (storagePath && settled(storagePath)) return;
    if (Date.now() > deadline) {
      logger.warn(
        { targetPath },
        'analyze finalization not visible after timeout; completing job anyway',
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, FINALIZE_SETTLE_POLL_MS));
  }
};

export function createLaunchAnalysisWorker(deps: LaunchDeps) {
  const { jobManager, backend, acquireRepoLock, releaseRepoLock, closeDbHandle, onAnalysisFinalized } =
    deps;

  return function launchAnalysisWorker(
    job: { id: string },
    targetPath: string,
    opts: LaunchOptions,
  ): void {
    // For waitForSettledIndex: files (re)written by this job have mtimes at or
    // after this instant. Taken before the fork so no worker write predates it.
    const jobStartMs = Date.now();
    // Acquire shared repo lock (keyed on storagePath to match embed handler)
    const analyzeLockKey = getStoragePath(targetPath);
    if (!opts.lockAlreadyHeld) {
      const lockErr = acquireRepoLock(analyzeLockKey);
      if (lockErr) {
        jobManager.updateJob(job.id, { status: 'failed', error: lockErr });
        return;
      }
    }

    jobManager.updateJob(job.id, { repoPath: targetPath, status: 'analyzing' });

    // 终态路径共享幂等锁释放，避免 error/complete/exit 竞态重复释放。
    let lockReleased = false;
    const releaseLock = (): void => {
      if (lockReleased || opts.lockAlreadyHeld) return;
      lockReleased = true;
      releaseRepoLock(analyzeLockKey);
    };

    // ── Worker fork with auto-retry ──────────────────────────────
    const callerPath = fileURLToPath(import.meta.url);
    const isDev = callerPath.endsWith('.ts');
    const workerFile = isDev ? 'analyze-worker.ts' : 'analyze-worker.js';
    const workerPath = path.join(path.dirname(callerPath), workerFile);
    const tsxHookArgs: string[] = isDev
      ? ['--import', pathToFileURL(_require.resolve('tsx/esm')).href]
      : [];

    // Worker heap: 8192MB historical default, but never above what this
    // machine/container actually has (#2649 review — a fixed 8192 inside a
    // smaller cgroup limit died to the kernel with a misleading remedy).
    // GITNEXUS_SERVER_ANALYZE_HEAP_MB overrides as an absolute value.
    const envHeapMb = Number(process.env.GITNEXUS_SERVER_ANALYZE_HEAP_MB);
    const workerHeapMb =
      Number.isInteger(envHeapMb) && envHeapMb > 0 ? envHeapMb : Math.min(8192, autoHeapCapMb());

    const forkWorker = () => {
      const currentJob = jobManager.getJob(job.id);
      if (!currentJob || currentJob.status === 'complete' || currentJob.status === 'failed') return;

      const attempt = currentJob.retryCount + 1;
      const child = fork(workerPath, [], {
        execArgv: buildAnalyzeWorkerExecArgv(tsxHookArgs, String(workerHeapMb)),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });

      // Capture stderr for this fork attempt's crash diagnostics only.
      let stderrChunks = '';
      let workerReportedTerminalOutcome = false;
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks = appendWorkerStderr(stderrChunks, chunk);
      });

      logger.info(
        {
          jobId: job.id,
          repoPath: targetPath,
          attempt,
          phase: currentJob.progress.phase,
          heapMb: workerHeapMb,
          embeddings: Boolean(opts.embeddings),
          deferEmbeddingRepair: Boolean(opts.deferEmbeddingRepair),
        },
        'Analyze worker started',
      );

      child.on('message', (msg: WorkerMessage) => {
        // Ignore any message once the job is terminal — a late worker message (a
        // SIGTERM-driven `error` after `complete`, or vice versa) must not
        // re-release the repo lock or flip the reported status. Mirrors the `exit`
        // handler guard below; pairs with the worker's terminal-claim (#2264 P3).
        const current = jobManager.getJob(job.id);
        if (!current || current.status === 'complete' || current.status === 'failed') return;
        if (msg.type === 'complete' || msg.type === 'error') workerReportedTerminalOutcome = true;

        if (msg.type === 'progress') {
          logger.info(
            {
              jobId: job.id,
              repoPath: targetPath,
              attempt,
              phase: msg.phase,
              percent: msg.percent,
              message: msg.message,
            },
            'Analyze worker progress',
          );
          jobManager.updateJob(job.id, {
            status: 'analyzing',
            progress: { phase: msg.phase, percent: msg.percent, message: msg.message },
          });
        } else if (msg.type === 'complete') {
          logger.info(
            { jobId: job.id, repoPath: targetPath, attempt, repoName: msg.result.repoName },
            'Analyze worker completed; finalizing index',
          );
          releaseLock();
          // LadybugDB requires its native file close/checkpoint to become visible
          // before re-opening a cached handle. Neo4j commits remotely, so it must
          // not probe the unrelated local lbug file or wait for its sidecars.
          const reload = isNeo4jBackendEnabled()
            ? Promise.resolve()
            : waitForSettledIndex(targetPath, jobStartMs).then(() => closeDbHandle());
          reload
            .catch(() => {}) // best-effort: eviction failure must not fail the job
            .then(() => backend.init())
            .then(() => {
              logger.info({ jobId: job.id, repoPath: targetPath }, 'Analyze index finalization complete');
              jobManager.updateJob(job.id, { status: 'complete', repoName: msg.result.repoName });
              try {
                onAnalysisFinalized?.(msg.result, { jobId: job.id, repoPath: targetPath });
              } catch (err) {
                logger.error(
                  { err, jobId: job.id, repoPath: targetPath },
                  'post-analysis finalizer could not schedule background work',
                );
              }
            })
            .catch((err) => {
              logger.error({ err }, 'backend.init() failed after analyze:');
              jobManager.updateJob(job.id, {
                status: 'failed',
                error: 'Server failed to reload after analysis. Try again.',
              });
            });
        } else if (msg.type === 'error') {
          releaseLock();
          // Only LadybugDB workers can rewrite a local database handle.
          if (!isNeo4jBackendEnabled()) {
            void closeDbHandle().catch(() => {});
          }
          jobManager.updateJob(job.id, { status: 'failed', error: msg.message });
        }
      });

      child.on('error', (err) => {
        releaseLock();
        const current = jobManager.getJob(job.id);
        const phase = current?.progress.phase ?? 'unknown';
        logger.error(
          {
            jobId: job.id,
            repoPath: targetPath,
            attempt,
            progress: { phase },
            exitCode: null,
            signal: null,
            err,
          },
          'Analyze worker process error',
        );
        jobManager.updateJob(job.id, {
          status: 'failed',
          error: `Worker process error (job ${job.id}, repo ${targetPath}, phase ${phase}, attempt ${attempt}, exitCode null, signal null): ${err.message}`,
        });
      });

      child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        const j = jobManager.getJob(job.id);
        if (!j) return;
        if (j.status === 'complete' || j.status === 'failed') {
          releaseLock();
          return;
        }
        if (code === 0 && signal === null && workerReportedTerminalOutcome) return;

        const phase = j.progress.phase;
        const stderrDiagnostic = workerStderrDiagnostic(stderrChunks);
        const context = {
          jobId: job.id,
          repoPath: targetPath,
          attempt,
          progress: { phase },
          exitCode: code,
          signal,
        };

        // Worker crashed — attempt retry if under the limit
        if (j.retryCount < MAX_WORKER_RETRIES) {
          j.retryCount++;
          const delay = 1000 * Math.pow(2, j.retryCount - 1); // 1s, 2s
          logger.warn(
            {
              ...context,
              stderr: stderrDiagnostic || undefined,
              retry: `${j.retryCount}/${MAX_WORKER_RETRIES}`,
              delayMs: delay,
            },
            `Analyze worker crashed (exitCode ${code}, signal ${signal ?? 'none'}); retry scheduled` +
              (stderrDiagnostic ? `: ${stderrDiagnostic}` : ''),
          );
          jobManager.updateJob(job.id, {
            status: 'analyzing',
            progress: {
              phase: 'retrying',
              percent: j.progress.percent,
              message: `Worker crashed (exitCode ${code}, signal ${signal ?? 'none'}), retrying (${j.retryCount}/${MAX_WORKER_RETRIES})...`,
            },
          });
          setTimeout(forkWorker, delay);
        } else {
          // Exhausted retries — permanent failure
          releaseLock();
          logger.error(
            { ...context, stderr: stderrDiagnostic || undefined, attempts: attempt },
            'Analyze worker retry exhaustion',
          );
          jobManager.updateJob(job.id, {
            status: 'failed',
            error: `Worker crashed after ${attempt} attempts (job ${job.id}, repo ${targetPath}, phase ${phase}, exitCode ${code}, signal ${signal ?? 'none'})${stderrDiagnostic ? `: ${stderrDiagnostic}` : ''}`,
          });
        }
      });

      // Register child for cancellation + timeout tracking
      jobManager.registerChild(job.id, child);

      // Send start command to child
      child.send({
        type: 'start',
        repoPath: targetPath,
        options: {
          force: !!opts.force,
          embeddings: !!opts.embeddings,
          dropEmbeddings: !!opts.dropEmbeddings,
          deferEmbeddingRepair: !!opts.deferEmbeddingRepair,
          ...(opts.registryName ? { registryName: opts.registryName } : {}),
          ...(opts.registryBranch ? { registryBranch: opts.registryBranch } : {}),
          ...(opts.allowDuplicateName !== undefined
            ? { allowDuplicateName: opts.allowDuplicateName }
            : {}),
        },
      });
    };

    forkWorker();
  };
}
