import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobManager } from '../../src/server/analyze-job.js';

const { children, forkMock } = vi.hoisted(() => ({
  children: [] as any[],
  forkMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  fork: forkMock,
}));

const makeChild = () => {
  const child = new EventEmitter() as any;
  child.stderr = new EventEmitter();
  child.send = vi.fn();
  child.kill = vi.fn();
  children.push(child);
  return child;
};

describe('createLaunchAnalysisWorker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
    children.length = 0;
  });

  it('does not retry when the worker exits with code 0 before backend reload completes', async () => {
    vi.useFakeTimers();
    forkMock.mockImplementation(makeChild);
    let finishReload!: () => void;
    const backend = {
      init: vi.fn(() => new Promise<void>((resolve) => (finishReload = resolve))),
    };
    const manager = new JobManager();
    const { createLaunchAnalysisWorker } = await import('../../src/server/analyze-launch.js');
    const launch = createLaunchAnalysisWorker({
      jobManager: manager,
      backend,
      acquireRepoLock: vi.fn(() => null),
      releaseRepoLock: vi.fn(),
    });
    const job = manager.createJob({ repoPath: 'D:/repo' });

    launch(job, 'D:/repo', {});
    children[0].emit('message', { type: 'complete', result: { repoName: 'repo' } });
    children[0].emit('exit', 0);
    vi.advanceTimersByTime(1000);
    finishReload();
    await Promise.resolve();

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(manager.getJob(job.id)?.status).toBe('complete');
    manager.dispose();
  });
});
