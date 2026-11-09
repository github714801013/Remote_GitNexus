import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobManager } from '../../src/server/analyze-job.js';

const { children, forkMock, neo4jEnabled, resolveResourcesMock } = vi.hoisted(() => ({
  children: [] as any[],
  forkMock: vi.fn(),
  neo4jEnabled: vi.fn(() => false),
  resolveResourcesMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  fork: forkMock,
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => cb(null, '')),
}));

vi.mock('../../src/core/neo4j/config.js', () => ({
  isNeo4jBackendEnabled: neo4jEnabled,
}));

// 官方新增的 embeddings 探测会读取真实仓库元数据；测试只验证 launch 流程本身。
vi.mock('../../src/core/analysis-host-resources.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/analysis-host-resources.js')>();
  resolveResourcesMock.mockImplementation(actual.resolveHostAnalysisResources);
  return {
    ...actual,
    analysisMayEmbed: vi.fn(async () => false),
    resolveHostAnalysisResources: resolveResourcesMock,
  };
});

// launch 在 fork 前会真实检查 targetPath 的存储归属；测试固定用 D:/repo，
// 宿主机若存在残留目录会因 'unowned' 失败，因此这里只验证 launch 流程本身。
vi.mock('../../src/storage/storage-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/storage-resolver.js')>();
  return {
    ...actual,
    requireStoragePath: vi.fn(async (repoPath: string) => repoPath),
  };
});

const makeChild = () => {
  const child = new EventEmitter() as any;
  child.stderr = new EventEmitter();
  child.send = vi.fn();
  child.kill = vi.fn();
  children.push(child);
  return child;
};

// launch 会先 await 存储归属校验再同步 fork；用微任务轮询代替定时器等待，
// 兼容各用例启用 fake timers 的场景。
const settleLaunch = async (expected = 1) => {
  for (let i = 0; i < 10 && children.length < expected; i += 1) await Promise.resolve();
  expect(children.length).toBeGreaterThanOrEqual(expected);
};

const makeLaunchDeps = (jobManager: JobManager, backend = { init: vi.fn(async () => undefined) }) => ({
  jobManager,
  backend,
  acquireRepoLock: vi.fn(() => null),
  releaseRepoLock: vi.fn(),
  closeDbHandle: vi.fn(async () => undefined),
});

describe('createLaunchAnalysisWorker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
    neo4jEnabled.mockReturnValue(false);
    children.length = 0;
  });

  it('does not wait for local LadybugDB files after a Neo4j worker completes', async () => {
    forkMock.mockImplementation(makeChild);
    neo4jEnabled.mockReturnValue(true);
    const manager = new JobManager();
    const backend = { init: vi.fn(async () => undefined) };
    const { createLaunchAnalysisWorker } = await import('../../src/server/analyze-launch.js');
    const launch = createLaunchAnalysisWorker(makeLaunchDeps(manager, backend));
    const job = manager.createJob({ repoPath: 'D:/repo' });

    launch(job, 'D:/repo', {});
    await settleLaunch();
    children[0].emit('message', { type: 'complete', result: { repoName: 'repo' } });
    // 官方在收到终态 IPC 后等 child 真正退出才结算，测试需补 exit。
    children[0].emit('exit', 0, null);
    await vi.waitFor(() => {
      expect(backend.init).toHaveBeenCalledTimes(1);
      expect(manager.getJob(job.id)?.status).toBe('complete');
    });
    manager.dispose();
  });

  it('marks the job failed instead of rejecting when the resource budget rejects the launch', async () => {
    const manager = new JobManager();
    const { createLaunchAnalysisWorker } = await import('../../src/server/analyze-launch.js');
    const launch = createLaunchAnalysisWorker(makeLaunchDeps(manager));
    const job = manager.createJob({ repoPath: 'D:/repo' });

    resolveResourcesMock.mockImplementationOnce(() => {
      throw new Error('Resource budget 24576 MiB cannot admit parser/model work');
    });
    await expect(launch(job, 'D:/repo', {})).resolves.toBeUndefined();

    expect(manager.getJob(job.id)?.status).toBe('failed');
    expect(manager.getJob(job.id)?.error).toContain('Resource budget');
    expect(forkMock).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('runs the post-finalization callback only after backend reload and analyze completion', async () => {
    forkMock.mockImplementation(makeChild);
    neo4jEnabled.mockReturnValue(true);
    const manager = new JobManager();
    const backend = { init: vi.fn(async () => undefined) };
    const onAnalysisFinalized = vi.fn();
    const { createLaunchAnalysisWorker } = await import('../../src/server/analyze-launch.js');
    const launch = createLaunchAnalysisWorker({
      ...makeLaunchDeps(manager, backend),
      onAnalysisFinalized,
    });
    const job = manager.createJob({ repoPath: 'D:/repo' });

    launch(job, 'D:/repo', {});
    await settleLaunch();
    children[0].emit('message', {
      type: 'complete',
      result: { repoName: 'repo', repoPath: 'D:/repo', stats: {}, embeddingRepairDeferred: true },
    });
    children[0].emit('exit', 0, null);

    await vi.waitFor(() => expect(onAnalysisFinalized).toHaveBeenCalledTimes(1));
    expect(backend.init).toHaveBeenCalledTimes(1);
    expect(manager.getJob(job.id)?.status).toBe('complete');
    expect(onAnalysisFinalized).toHaveBeenCalledWith(
      expect.objectContaining({ repoName: 'repo', embeddingRepairDeferred: true }),
      { jobId: job.id, repoPath: 'D:/repo' },
    );
    manager.dispose();
  });

  it('does not close a local database handle after a Neo4j worker error', async () => {
    forkMock.mockImplementation(makeChild);
    neo4jEnabled.mockReturnValue(true);
    const manager = new JobManager();
    const deps = makeLaunchDeps(manager);
    const { createLaunchAnalysisWorker } = await import('../../src/server/analyze-launch.js');
    const launch = createLaunchAnalysisWorker(deps);
    const job = manager.createJob({ repoPath: 'D:/repo' });

    launch(job, 'D:/repo', {});
    await settleLaunch();
    children[0].emit('message', { type: 'error', message: 'Neo4j write failed' });
    children[0].emit('exit', 1, null);

    expect(deps.closeDbHandle).not.toHaveBeenCalled();
    expect(manager.getJob(job.id)?.status).toBe('failed');
    manager.dispose();
  });

  it('releases the repo lock after a cancelled worker exits', async () => {
    forkMock.mockImplementation(makeChild);
    const manager = new JobManager();
    const deps = makeLaunchDeps(manager);
    const { createLaunchAnalysisWorker } = await import('../../src/server/analyze-launch.js');
    const launch = createLaunchAnalysisWorker(deps);
    const job = manager.createJob({ repoPath: 'D:/repo' });

    launch(job, 'D:/repo', {});
    await settleLaunch();
    expect(manager.cancelJob(job.id)).toBe(true);
    children[0].emit('exit', 0, null);

    expect(deps.releaseRepoLock).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it('does not retry when the worker exits with code 0 after reporting completion', async () => {
    forkMock.mockImplementation(makeChild);
    neo4jEnabled.mockReturnValue(true);
    let finishReload!: () => void;
    const backend = {
      init: vi.fn(() => new Promise<void>((resolve) => (finishReload = resolve))),
    };
    const manager = new JobManager();
    const { createLaunchAnalysisWorker } = await import('../../src/server/analyze-launch.js');
    const launch = createLaunchAnalysisWorker(makeLaunchDeps(manager, backend));
    const job = manager.createJob({ repoPath: 'D:/repo' });

    launch(job, 'D:/repo', {});
    await settleLaunch();
    children[0].emit('message', { type: 'complete', result: { repoName: 'repo' } });
    children[0].emit('exit', 0, null);
    await vi.waitFor(() => expect(backend.init).toHaveBeenCalledTimes(1));
    finishReload();
    await vi.waitFor(() => expect(manager.getJob(job.id)?.status).toBe('complete'));

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(manager.getJob(job.id)?.status).toBe('complete');
    manager.dispose();
  });

  it('retries when the worker exits with code 0 before reporting a terminal outcome', async () => {
    vi.useFakeTimers();
    forkMock.mockImplementation(makeChild);
    const manager = new JobManager();
    const { createLaunchAnalysisWorker } = await import('../../src/server/analyze-launch.js');
    const launch = createLaunchAnalysisWorker(makeLaunchDeps(manager));
    const job = manager.createJob({ repoPath: 'D:/repo' });

    try {
      launch(job, 'D:/repo', {});
      await settleLaunch();
      children[0].emit('message', {
        type: 'progress',
        phase: 'neo4j',
        percent: 80,
        message: 'Writing Neo4j nodes 1/1...',
      });
      children[0].emit('exit', 0, null);
      vi.advanceTimersByTime(1000);

      expect(forkMock).toHaveBeenCalledTimes(2);
      expect(manager.getJob(job.id)?.progress.message).toContain('exitCode 0');
      expect(manager.getJob(job.id)?.progress.percent).toBe(80);
    } finally {
      manager.dispose();
      vi.clearAllTimers();
    }
  });

  it('fails and releases the repo lock after repeated silent zero exits', async () => {
    vi.useFakeTimers();
    forkMock.mockImplementation(makeChild);
    const manager = new JobManager();
    const deps = makeLaunchDeps(manager);
    const { createLaunchAnalysisWorker } = await import('../../src/server/analyze-launch.js');
    const launch = createLaunchAnalysisWorker(deps);
    const job = manager.createJob({ repoPath: 'D:/repo' });

    try {
      launch(job, 'D:/repo', {});
      await settleLaunch();
      children[0].emit('exit', 0, null);
      vi.advanceTimersByTime(1000);
      children[1].emit('exit', 0, null);
      vi.advanceTimersByTime(2000);
      children[2].emit('exit', 0, null);

      expect(manager.getJob(job.id)?.status).toBe('failed');
      expect(manager.getJob(job.id)?.error).toContain('after 3 attempts');
      expect(deps.releaseRepoLock).toHaveBeenCalledTimes(1);
    } finally {
      manager.dispose();
      vi.clearAllTimers();
    }
  });

  it.each(['SIGABRT', 'SIGKILL'] as const)(
    'reports the child exit signal %s in crash logs and retry progress',
    async (signal) => {
      vi.useFakeTimers();
      forkMock.mockImplementation(makeChild);
      const { _captureLogger } = await import('../../src/core/logger.js');
      const capture = _captureLogger();
      const manager = new JobManager();
      const { createLaunchAnalysisWorker } = await import('../../src/server/analyze-launch.js');
      const launch = createLaunchAnalysisWorker(makeLaunchDeps(manager));
      const job = manager.createJob({ repoPath: 'D:/repo' });

      try {
        launch(job, 'D:/repo', {});
        await settleLaunch();
        children[0].emit('exit', null, signal);

        expect(capture.records().some((record) => record.msg.includes(signal))).toBe(true);
        expect(manager.getJob(job.id)?.progress.message).toContain(signal);
      } finally {
        capture.restore();
        manager.dispose();
        vi.clearAllTimers();
      }
    },
  );

  it('bounds captured stderr and retains a truncation marker', async () => {
    forkMock.mockImplementation(makeChild);
    const { _captureLogger } = await import('../../src/core/logger.js');
    const capture = _captureLogger();
    const manager = new JobManager();
    const { createLaunchAnalysisWorker } = await import('../../src/server/analyze-launch.js');
    const launch = createLaunchAnalysisWorker(makeLaunchDeps(manager));
    const job = manager.createJob({ repoPath: 'D:/repo' });

    try {
      launch(job, 'D:/repo', {});
      await settleLaunch();
      children[0].stderr.emit('data', Buffer.from(`stderr-marker${'x'.repeat(9000)}`));
      children[0].emit('exit', null, 'SIGABRT');
      await new Promise((resolve) => setImmediate(resolve));
      expect(capture.text()).toContain('worker crashed');

      const crashLog = capture.records().find((record) => record.msg.includes('worker crashed'));
      expect(crashLog?.msg).toContain('stderr truncated');
      expect(crashLog?.stderr).toContain('stderr truncated');
      expect(String(crashLog?.stderr).length).toBeLessThan(4097);
    } finally {
      capture.restore();
      manager.dispose();
      vi.clearAllTimers();
    }
  });

  it('includes attempt, phase, repository, and job in retry exhaustion errors', async () => {
    vi.useFakeTimers();
    forkMock.mockImplementation(makeChild);
    const manager = new JobManager();
    const { createLaunchAnalysisWorker } = await import('../../src/server/analyze-launch.js');
    const launch = createLaunchAnalysisWorker(makeLaunchDeps(manager));
    const job = manager.createJob({ repoPath: 'D:/repo' });

    try {
      launch(job, 'D:/repo', {});
      await settleLaunch();
      children[0].emit('message', {
        type: 'progress',
        phase: 'indexing',
        percent: 42,
        message: 'Indexing',
      });
      children[0].emit('exit', null, 'SIGABRT');
      vi.advanceTimersByTime(1000);
      children[1].emit('exit', null, 'SIGKILL');
      vi.advanceTimersByTime(2000);
      children[2].emit('exit', null, 'SIGABRT');

      const error = manager.getJob(job.id)?.error ?? '';
      expect(error).toContain('after 3 attempts');
      expect(error).toContain('retrying');
      expect(error).toContain('D:/repo');
      expect(error).toContain(job.id);
    } finally {
      manager.dispose();
      vi.clearAllTimers();
    }
  });

  it('does not reuse stderr from a previous attempt when the next attempt is silent', async () => {
    vi.useFakeTimers();
    forkMock.mockImplementation(makeChild);
    const manager = new JobManager();
    const { createLaunchAnalysisWorker } = await import('../../src/server/analyze-launch.js');
    const launch = createLaunchAnalysisWorker(makeLaunchDeps(manager));
    const job = manager.createJob({ repoPath: 'D:/repo' });

    try {
      launch(job, 'D:/repo', {});
      await settleLaunch();
      children[0].stderr.emit('data', Buffer.from('previous-attempt-marker'));
      children[0].emit('exit', null, 'SIGABRT');
      vi.advanceTimersByTime(1000);
      children[1].emit('exit', null, 'SIGKILL');
      vi.advanceTimersByTime(2000);
      children[2].emit('exit', null, 'SIGABRT');

      expect(manager.getJob(job.id)?.error).not.toContain('previous-attempt-marker');
    } finally {
      manager.dispose();
      vi.clearAllTimers();
    }
  });
});
