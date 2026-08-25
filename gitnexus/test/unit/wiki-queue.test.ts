import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegistryEntry } from '../../src/storage/repo-manager.js';

const mocks = vi.hoisted(() => ({
  loadMeta: vi.fn(),
  resolveLLMConfig: vi.fn(),
  generatorRun: vi.fn(),
}));

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  loadMeta: mocks.loadMeta,
}));

vi.mock('../../src/core/wiki/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/wiki/llm-client.js')>()),
  resolveLLMConfig: mocks.resolveLLMConfig,
}));

vi.mock('../../src/core/wiki/generator.js', () => ({
  WikiGenerator: class {
    run = mocks.generatorRun;
  },
}));

const entry = (path: string, commit = 'a'.repeat(40)): RegistryEntry => ({
  name: 'same-name',
  path,
  storagePath: `${path}/.gitnexus`,
  indexedAt: '2026-08-25T00:00:00.000Z',
  lastCommit: commit,
});

describe('WikiQueue', () => {
  afterEach(() => {
    mocks.loadMeta.mockResolvedValue(null);
    vi.clearAllMocks();
  });

  it('deduplicates the same repository identity and indexed commit', async () => {
    const { WikiQueue } = await import('../../src/server/wiki-queue.js');
    const queue = new WikiQueue();
    const repo = entry('D:/repo');

    mocks.loadMeta.mockResolvedValue({ lastCommit: repo.lastCommit });
    mocks.resolveLLMConfig.mockResolvedValue({ apiKey: '', provider: 'openai' });
    const first = queue.enqueue(repo, repo.lastCommit);
    const duplicate = queue.enqueue(repo, repo.lastCommit);

    expect(first.status).toBe('accepted');
    expect(duplicate.status).toBe('deferred');
    await expect(first.done).rejects.toThrow('LLM configuration unavailable');
    await expect(duplicate.done).rejects.toThrow('LLM configuration unavailable');
  });

  it('keeps same-name repositories at different paths independent', async () => {
    const { WikiQueue } = await import('../../src/server/wiki-queue.js');
    const queue = new WikiQueue();
    const left = entry('D:/left');
    const right = entry('D:/right');

    mocks.loadMeta.mockResolvedValue({ lastCommit: left.lastCommit });
    mocks.resolveLLMConfig.mockResolvedValue({ apiKey: '', provider: 'openai' });
    queue.enqueue(left, left.lastCommit).done.catch(() => {});
    queue.enqueue(right, right.lastCommit).done.catch(() => {});

    expect(queue.getLifecycle(left).sourceCommit).toBe(left.lastCommit);
    expect(queue.getLifecycle(right).sourceCommit).toBe(right.lastCommit);
  });
});
