import { describe, expect, it } from 'vitest';
import { WebhookAnalyzeQueue } from '../../src/server/webhook-analyze-queue.js';

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
});
