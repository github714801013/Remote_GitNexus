import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { JobManager } from '../../src/server/analyze-job.js';
import {
  isRepoAlreadyActiveError,
  isRepairableIndexError,
  getWebhookEnvReposFile,
  loadWebhookInspectionTargets,
  shouldScheduleStartupIncrementalAnalyze,
  shouldScheduleStartupEmbeddings,
  shouldScheduleStartupWebhookRepos,
  shouldRunStartupLbugHealthCheck,
  shouldTreatAnalyzeWorkerExitAsCrash,
} from '../../src/server/api.js';

describe('analyze API logic', () => {
  let manager: JobManager;

  beforeEach(() => {
    manager = new JobManager();
  });

  afterEach(() => {
    manager.dispose();
    delete process.env.GITNEXUS_STORAGE_BACKEND;
    delete process.env.GITNEXUS_STARTUP_WEBHOOK_REPOS_ENABLED;
  });

  it('creates a job and returns 202 shape', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    const response = { jobId: job.id, status: job.status };
    expect(response.jobId).toBeTruthy();
    expect(response.status).toBe('queued');
  });

  it('creates a separate job when another repo is already active', () => {
    const job1 = manager.createJob({ repoUrl: 'https://github.com/user/repo1' });
    manager.updateJob(job1.id, { status: 'analyzing' });
    const job2 = manager.createJob({ repoUrl: 'https://github.com/user/repo2' });
    expect(job2.id).not.toBe(job1.id);
  });

  it('returns existing job for same repo URL', () => {
    const job1 = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    manager.updateJob(job1.id, { status: 'analyzing' });
    const job2 = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    expect(job2.id).toBe(job1.id);
  });

  it('SSE progress listener receives all events including terminal', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/sse-test' });
    const events: any[] = [];
    const unsub = manager.onProgress(job.id, (progress) => {
      events.push(progress);
    });

    manager.updateJob(job.id, {
      status: 'analyzing',
      progress: { phase: 'parsing', percent: 30, message: 'Parsing' },
    });
    manager.updateJob(job.id, {
      progress: { phase: 'calls', percent: 50, message: 'Tracing calls' },
    });
    manager.updateJob(job.id, { status: 'complete', repoName: 'sse-test' });

    unsub();

    expect(events.length).toBe(3);
    expect(events[0].phase).toBe('parsing');
    expect(events[1].phase).toBe('calls');
    expect(events[2].phase).toBe('complete');
    expect(events[2].percent).toBe(100);
  });

  it('does not write job progress directly to server logs', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const job = manager.createJob({ repoPath: '/repo/memory' });

    manager.updateJob(job.id, {
      status: 'analyzing',
      progress: {
        phase: 'enriching',
        percent: 0,
        message: '[memory] phase=parse marker=start heapUsedMb=10 rssMb=20 retainedResults=1',
      },
    });

    expect(info).not.toHaveBeenCalled();

    info.mockRestore();
  });

  it('does not treat exit after worker terminal message as a crash', () => {
    expect(shouldTreatAnalyzeWorkerExitAsCrash('analyzing', true)).toBe(false);
    expect(shouldTreatAnalyzeWorkerExitAsCrash('analyzing', false)).toBe(true);
  });

  it('classifies damaged LadybugDB indexes as repairable', () => {
    expect(isRepairableIndexError(new Error('LadybugDB not initialized for repo "x"'))).toBe(true);
    expect(
      isRepairableIndexError(
        new Error('LadybugDB at /repo/.gitnexus/lbug failed integrity check: Mmap failed'),
      ),
    ).toBe(true);
    expect(isRepairableIndexError(new Error('Repository path is not a git repository'))).toBe(
      false,
    );
  });

  it('classifies active repository analyze locks as skippable webhook conflicts', () => {
    expect(
      isRepoAlreadyActiveError(new Error('Another job is already active for this repository')),
    ).toBe(true);
    expect(isRepoAlreadyActiveError(new Error('Worker crashed'))).toBe(false);
  });

  it('schedules startup embeddings only for indexed repos without vectors', () => {
    expect(shouldScheduleStartupEmbeddings({ stats: { nodes: 10, embeddings: 0 } })).toBe(true);
    expect(shouldScheduleStartupEmbeddings({ stats: { nodes: 10 } })).toBe(true);
    expect(shouldScheduleStartupEmbeddings({ stats: { nodes: 10, embeddings: 3 } })).toBe(false);
    expect(shouldScheduleStartupEmbeddings({ stats: { nodes: 10, embeddings: 3 } }, 0)).toBe(true);
    expect(shouldScheduleStartupEmbeddings({ stats: { nodes: 10, embeddings: 0 } }, 3)).toBe(false);
    expect(
      shouldScheduleStartupEmbeddings({
        embeddingStatus: 'running',
        stats: { nodes: 10, embeddings: 3 },
      }),
    ).toBe(true);
    // RUNNING 状态区分活跃与僵尸：无 indexedAt 视为僵尸（重试）
    expect(
      shouldScheduleStartupEmbeddings({
        embeddingStatus: 'running',
        indexedAt: undefined,
        stats: { nodes: 10, embeddings: 3 },
      }),
    ).toBe(true);
    // RUNNING 且 indexedAt 在超时阈值内（活跃 repair 进行中）→ 不重复 enqueue
    const recentIso = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 分钟前
    expect(
      shouldScheduleStartupEmbeddings({
        embeddingStatus: 'running',
        indexedAt: recentIso,
        stats: { nodes: 10, embeddings: 3 },
      }),
    ).toBe(false);
    // RUNNING 且 indexedAt 超过超时阈值（僵尸状态）→ 允许重试
    const staleIso = new Date(Date.now() - 45 * 60 * 1000).toISOString(); // 45 分钟前
    expect(
      shouldScheduleStartupEmbeddings({
        embeddingStatus: 'running',
        indexedAt: staleIso,
        stats: { nodes: 10, embeddings: 3 },
      }),
    ).toBe(true);
    // RUNNING 活跃但 embeddings=0 → 仍需补（nodes>0 且 embeddings<=0）
    expect(
      shouldScheduleStartupEmbeddings({
        embeddingStatus: 'running',
        indexedAt: recentIso,
        stats: { nodes: 10, embeddings: 0 },
      }),
    ).toBe(true);
    expect(
      shouldScheduleStartupEmbeddings({
        embeddingStatus: 'failed',
        stats: { nodes: 10, embeddings: 3 },
      }),
    ).toBe(true);
    expect(
      shouldScheduleStartupEmbeddings({
        embeddingStatus: 'complete',
        stats: { nodes: 10, embeddings: 3 },
      }),
    ).toBe(false);
    expect(shouldScheduleStartupEmbeddings({ stats: { nodes: 0, embeddings: 0 } })).toBe(false);
    expect(shouldScheduleStartupEmbeddings(null)).toBe(false);
  });

  it('schedules startup incremental analyze only when the index is behind HEAD', () => {
    expect(shouldScheduleStartupIncrementalAnalyze({ isStale: true, commitsBehind: 2 })).toBe(true);
    expect(shouldScheduleStartupIncrementalAnalyze({ isStale: true, commitsBehind: 0 })).toBe(
      false,
    );
    expect(shouldScheduleStartupIncrementalAnalyze({ isStale: false, commitsBehind: 0 })).toBe(
      false,
    );
  });

  it('skips startup lbug health checks when Neo4j is the storage backend', () => {
    expect(shouldRunStartupLbugHealthCheck()).toBe(true);

    process.env.GITNEXUS_STORAGE_BACKEND = 'neo4j';

    expect(shouldRunStartupLbugHealthCheck()).toBe(false);
  });

  it('does not enqueue all webhook repos on startup unless explicitly enabled', () => {
    expect(shouldScheduleStartupWebhookRepos()).toBe(false);

    process.env.GITNEXUS_STARTUP_WEBHOOK_REPOS_ENABLED = 'true';

    expect(shouldScheduleStartupWebhookRepos()).toBe(true);
  });

  it('loads ordinary and env webhook repos as separate inspection targets', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-webhook-targets-test-'));
    await writeFile(
      path.join(tempRoot, 'repos.json'),
      JSON.stringify([
        {
          full_name: 'oa-java/oa-after',
          clone_url: 'https://code.9ji.com/oa-java/oa-after.git',
          branch: 'release_9ji',
        },
      ]),
    );
    await writeFile(
      getWebhookEnvReposFile(tempRoot, 'dev'),
      JSON.stringify([
        {
          full_name: 'oa-java/oa-after',
          clone_url: 'https://code.9ji.com/oa-java/oa-after.git',
          branch: 'dev',
        },
      ]),
    );

    const targets = await loadWebhookInspectionTargets(tempRoot);

    expect(targets).toEqual([
      expect.objectContaining({
        fullName: 'oa-java/oa-after',
        repoPath: path.join(tempRoot, 'oa-java', 'oa-after'),
        branch: 'release_9ji',
        repoName: 'oa-after',
        registryName: 'oa-after',
        env: undefined,
      }),
      expect.objectContaining({
        fullName: 'oa-java/oa-after',
        repoPath: path.join(tempRoot, 'oa-java', 'dev-oa-after'),
        branch: 'dev',
        repoName: 'dev-oa-after',
        registryName: 'dev-oa-after',
        env: 'dev',
      }),
    ]);
  });
});
