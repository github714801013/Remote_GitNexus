import { describe, expect, it, vi } from 'vitest';
import {
  createEmbeddingRepairCoordinator,
  type EmbeddingRepairCoordinatorDependencies,
} from '../../src/server/embedding-repair-coordinator.js';

type QueuedTask = () => Promise<void>;

const createHarness = (overrides: Partial<EmbeddingRepairCoordinatorDependencies> = {}) => {
  const tasks: QueuedTask[] = [];
  const onReleased = vi.fn<(repo: string) => void>();
  const queue = {
    enqueue: vi.fn((_repo: string, task: QueuedTask) => {
      tasks.push(task);
    }),
  };
  const runner = { run: vi.fn(async () => {}) };
  const lock = {
    tryAcquire: vi.fn(() => true),
    release: vi.fn(),
    onReleased: vi.fn((listener: (repo: string) => void) => {
      onReleased.mockImplementation(listener);
      return () => {};
    }),
  };
  const timers = {
    setTimeout: vi.fn((_task: () => void, _delayMs: number) => 0),
  };
  const now = vi.fn(() => '2026-08-12T00:00:00.000Z');
  const coordinator = createEmbeddingRepairCoordinator({
    queue,
    runner,
    lock,
    timers,
    now,
    ...overrides,
  });

  return { coordinator, lock, now, onReleased, queue, runner, tasks, timers };
};

describe('embedding repair coordinator', () => {
  it('deduplicates an active round for the same repository', () => {
    const { coordinator, queue } = createHarness();

    const first = coordinator.request({ repo: 'repo-a', source: 'startup' });
    const duplicate = coordinator.request({ repo: 'repo-a', source: 'manual' });

    expect(duplicate).toEqual(first);
    expect(duplicate).toMatchObject({
      repo: 'repo-a',
      source: 'startup',
      round: 1,
      attempt: 0,
      status: 'queued',
    });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('waits for a held lock and re-enters when the lock release notification arrives', async () => {
    const { coordinator, lock, onReleased, queue, runner, tasks } = createHarness();
    lock.tryAcquire.mockReturnValueOnce(false).mockReturnValueOnce(true);

    coordinator.request({ repo: 'repo-a', source: 'startup' });
    await tasks.shift()?.();

    expect(coordinator.get('repo-a')).toMatchObject({ status: 'waiting_for_lock', attempt: 0 });
    expect(runner.run).not.toHaveBeenCalled();

    onReleased('repo-a');
    onReleased('repo-a');
    await tasks.shift()?.();

    expect(runner.run).toHaveBeenCalledWith('repo-a');
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
    expect(coordinator.get('repo-a')).toBeUndefined();
  });

  it('fails a round after three unsuccessful attempts with one- then two-second backoff', async () => {
    const { coordinator, runner, tasks, timers } = createHarness();
    runner.run.mockRejectedValue(new Error('embedding service unavailable'));

    coordinator.request({ repo: 'repo-a', source: 'finalization' });
    await tasks.shift()?.();
    expect(timers.setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 1_000);
    await timers.setTimeout.mock.calls[0][0]();

    await tasks.shift()?.();
    expect(timers.setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 2_000);
    await timers.setTimeout.mock.calls[1][0]();

    await expect(tasks.shift()?.()).rejects.toThrow('embedding service unavailable');

    expect(runner.run).toHaveBeenCalledTimes(3);
    expect(coordinator.get('repo-a')).toMatchObject({
      round: 1,
      attempt: 3,
      status: 'failed',
    });
    expect(timers.setTimeout).toHaveBeenCalledTimes(2);
  });

  it('opens a new round when manual repair follows a failed round', async () => {
    const { coordinator, runner, tasks, timers } = createHarness();
    runner.run.mockRejectedValue(new Error('embedding service unavailable'));

    coordinator.request({ repo: 'repo-a', source: 'startup' });
    await tasks.shift()?.();
    await timers.setTimeout.mock.calls[0][0]();
    await tasks.shift()?.();
    await timers.setTimeout.mock.calls[1][0]();
    await expect(tasks.shift()?.()).rejects.toThrow('embedding service unavailable');

    const manual = coordinator.request({ repo: 'repo-a', source: 'manual' });

    expect(manual).toMatchObject({
      repo: 'repo-a',
      source: 'manual',
      round: 2,
      attempt: 0,
      status: 'queued',
    });
  });
});
