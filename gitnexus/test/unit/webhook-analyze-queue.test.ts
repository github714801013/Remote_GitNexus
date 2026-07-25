import { describe, expect, it, vi } from 'vitest';
import {
  WebhookAnalyzeQueue,
  WebhookStartStaggerGate,
} from '../../src/server/webhook-analyze-queue.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

describe('WebhookAnalyzeQueue', () => {
  it('runs one task at a time and starts queued repos after the active task completes', async () => {
    const queue = new WebhookAnalyzeQueue();
    const first = deferred<void>();
    const started: string[] = [];

    const firstResult = queue.enqueue({
      key: 'repo-a',
      run: async () => {
        started.push('repo-a');
        await first.promise;
      },
    });
    const secondResult = queue.enqueue({
      key: 'repo-b',
      run: async () => {
        started.push('repo-b');
      },
    });

    expect(firstResult.status).toBe('accepted');
    expect(secondResult.status).toBe('accepted');
    await Promise.resolve();
    expect(started).toEqual(['repo-a']);

    first.resolve();
    await firstResult.done;
    await secondResult.done;
    expect(started).toEqual(['repo-a', 'repo-b']);
  });

  it('defers duplicate repo requests while preserving the latest pending task', async () => {
    const queue = new WebhookAnalyzeQueue();
    const first = deferred<void>();
    const started: string[] = [];

    const firstResult = queue.enqueue({
      key: 'repo-a',
      run: async () => {
        started.push('first');
        await first.promise;
      },
    });
    const duplicateOne = queue.enqueue({
      key: 'repo-a',
      run: async () => {
        started.push('duplicate-one');
      },
    });
    const duplicateTwo = queue.enqueue({
      key: 'repo-a',
      run: async () => {
        started.push('duplicate-two');
      },
    });

    expect(duplicateOne.status).toBe('deferred');
    expect(duplicateTwo.status).toBe('deferred');
    await Promise.resolve();
    expect(started).toEqual(['first']);

    first.resolve();
    await firstResult.done;
    await duplicateTwo.done;
    expect(started).toEqual(['first', 'duplicate-two']);
  });

  it('prioritizes the latest duplicate repo request before unrelated queued repos', async () => {
    const queue = new WebhookAnalyzeQueue();
    const first = deferred<void>();
    const started: string[] = [];

    const firstResult = queue.enqueue({
      key: 'repo-a',
      run: async () => {
        started.push('first');
        await first.promise;
      },
    });
    const otherResult = queue.enqueue({
      key: 'repo-b',
      run: async () => {
        started.push('other');
      },
    });
    const duplicateResult = queue.enqueue({
      key: 'repo-a',
      run: async () => {
        started.push('duplicate');
      },
    });

    expect(otherResult.status).toBe('accepted');
    expect(duplicateResult.status).toBe('deferred');
    await Promise.resolve();
    expect(started).toEqual(['first']);

    first.resolve();
    await firstResult.done;
    await duplicateResult.done;
    await otherResult.done;
    expect(started).toEqual(['first', 'duplicate', 'other']);
  });

  it('starts another repo after the active task releases its structure slot', async () => {
    const queue = new WebhookAnalyzeQueue();
    const embedding = deferred<void>();
    const started: string[] = [];

    const firstResult = queue.enqueue({
      key: 'repo-a',
      run: async (releaseStructureSlot) => {
        started.push('repo-a');
        releaseStructureSlot();
        await embedding.promise;
      },
    });
    const secondResult = queue.enqueue({
      key: 'repo-b',
      run: async () => {
        started.push('repo-b');
      },
    });

    await Promise.resolve();
    expect(started).toEqual(['repo-a', 'repo-b']);

    await secondResult.done;
    embedding.resolve();
    await firstResult.done;
  });

  it('keeps duplicate repo requests deferred after the structure slot is released', async () => {
    const queue = new WebhookAnalyzeQueue();
    const embedding = deferred<void>();
    const started: string[] = [];

    const firstResult = queue.enqueue({
      key: 'repo-a',
      run: async (releaseStructureSlot) => {
        started.push('first');
        releaseStructureSlot();
        await embedding.promise;
      },
    });
    const duplicateResult = queue.enqueue({
      key: 'repo-a',
      run: async () => {
        started.push('duplicate');
      },
    });

    expect(duplicateResult.status).toBe('deferred');
    await Promise.resolve();
    expect(started).toEqual(['first']);

    embedding.resolve();
    await firstResult.done;
    await duplicateResult.done;
    expect(started).toEqual(['first', 'duplicate']);
  });

  it('staggers each queued project start when concurrency allows parallel jobs', async () => {
    vi.useFakeTimers();
    let now = 0;
    const queue = new WebhookAnalyzeQueue(2, {
      startStaggerMs: 300_000,
      now: () => now,
    });
    const first = deferred<void>();
    const started: string[] = [];

    try {
      const firstResult = queue.enqueue({
        key: 'repo-a',
        run: async () => {
          started.push('repo-a');
          await first.promise;
        },
      });
      const secondResult = queue.enqueue({
        key: 'repo-b',
        run: async () => {
          started.push('repo-b');
        },
      });

      await Promise.resolve();
      expect(firstResult.status).toBe('accepted');
      expect(secondResult.status).toBe('accepted');
      expect(started).toEqual(['repo-a']);

      now += 299_999;
      await vi.advanceTimersByTimeAsync(299_999);
      expect(started).toEqual(['repo-a']);

      now += 1;
      await vi.advanceTimersByTimeAsync(1);
      expect(started).toEqual(['repo-a', 'repo-b']);

      await secondResult.done;
      first.resolve();
      await firstResult.done;
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares start staggering across structure and embedding queues', async () => {
    vi.useFakeTimers();
    let now = 0;
    const startGate = new WebhookStartStaggerGate(300_000, () => now);
    const structureQueue = new WebhookAnalyzeQueue(2, { startGate });
    const embeddingQueue = new WebhookAnalyzeQueue(2, { startGate });
    const structure = deferred<void>();
    const started: string[] = [];

    try {
      const structureResult = structureQueue.enqueue({
        key: 'structure-repo',
        run: async () => {
          started.push('structure-repo');
          await structure.promise;
        },
      });
      const embeddingResult = embeddingQueue.enqueue({
        key: 'embedding-repo',
        run: async () => {
          started.push('embedding-repo');
        },
      });

      await Promise.resolve();
      expect(started).toEqual(['structure-repo']);

      now += 299_999;
      await vi.advanceTimersByTimeAsync(299_999);
      expect(started).toEqual(['structure-repo']);

      now += 1;
      await vi.advanceTimersByTimeAsync(1);
      expect(started).toEqual(['structure-repo', 'embedding-repo']);

      await embeddingResult.done;
      structure.resolve();
      await structureResult.done;
    } finally {
      vi.useRealTimers();
    }
  });
});
