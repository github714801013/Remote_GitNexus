import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JobManager } from '../../src/server/analyze-job.js';
import {
  isRepoAlreadyActiveError,
  isRepairableIndexError,
  shouldScheduleStartupIncrementalAnalyze,
  shouldScheduleStartupEmbeddings,
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
});
