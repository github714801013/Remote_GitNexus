import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { RegistryEntry } from '../../src/storage/repo-manager.js';

const mocks = vi.hoisted(() => ({
  loadMeta: vi.fn(),
  resolveLLMConfig: vi.fn(),
  generatorRun: vi.fn(),
  isNeo4jBackendEnabled: vi.fn(() => false),
  instances: [] as any[],
}));

vi.mock('../../src/core/neo4j/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/neo4j/config.js')>()),
  isNeo4jBackendEnabled: mocks.isNeo4jBackendEnabled,
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
    repoPath: string;
    storagePath: string;
    lbugPath: string;
    llmConfig: any;
    options: any;
    constructor(
      repoPath: string,
      storagePath: string,
      lbugPath: string,
      llmConfig: any,
      options: any,
    ) {
      this.repoPath = repoPath;
      this.storagePath = storagePath;
      this.lbugPath = lbugPath;
      this.llmConfig = llmConfig;
      this.options = options;
      mocks.instances.push(this);
    }
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

const tempRepo = async (): Promise<RegistryEntry> => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-wiki-test-'));
  const repoPath = path.join(tmp, 'repo');
  await fs.mkdir(repoPath, { recursive: true });
  const repo = entry(repoPath);
  await fs.mkdir(repo.storagePath, { recursive: true });
  return repo;
};

describe('WikiQueue', () => {
  afterEach(() => {
    vi.resetAllMocks();
    mocks.loadMeta.mockResolvedValue(null);
    mocks.instances.length = 0;
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
    const leftTask = queue.enqueue(left, left.lastCommit);
    const rightTask = queue.enqueue(right, right.lastCommit);
    await leftTask.done.catch(() => {});
    await rightTask.done.catch(() => {});

    expect(queue.getLifecycle(left).sourceCommit).toBe(left.lastCommit);
    expect(queue.getLifecycle(right).sourceCommit).toBe(right.lastCommit);
  });

  it('Neo4j 模式构造参数：不传本地 lbug 路径并传 repoName', async () => {
    mocks.isNeo4jBackendEnabled.mockReturnValue(true);
    const { WikiQueue } = await import('../../src/server/wiki-queue.js');
    const queue = new WikiQueue();
    const repo = entry('D:/repo');

    mocks.loadMeta.mockResolvedValue({ lastCommit: repo.lastCommit });
    mocks.resolveLLMConfig.mockResolvedValue({ apiKey: 'k', provider: 'openai' });
    mocks.generatorRun.mockRejectedValue(new Error('LLM request timed out'));

    const enqueued = queue.enqueue(repo, repo.lastCommit);
    await expect(enqueued.done).rejects.toThrow('LLM request timed out');

    expect(mocks.instances).toHaveLength(1);
    expect(mocks.instances[0].lbugPath).toBe('');
    expect(mocks.instances[0].options.repoName).toBe('same-name');
  });

  it('Neo4j 模式成功闭环：stage 产物原子发布且 sourceCommit 对齐', async () => {
    mocks.isNeo4jBackendEnabled.mockReturnValue(true);
    const { WikiQueue } = await import('../../src/server/wiki-queue.js');
    const queue = new WikiQueue();
    const repo = await tempRepo();

    mocks.loadMeta.mockResolvedValue({ lastCommit: repo.lastCommit });
    mocks.resolveLLMConfig.mockResolvedValue({ apiKey: 'k', provider: 'openai' });
    mocks.generatorRun.mockImplementation(async function (this: any) {
      const dir: string = this.options.outputDir;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'meta.json'),
        JSON.stringify({ fromCommit: repo.lastCommit, generatedAt: '2026-08-26T10:00:00.000Z' }),
      );
      await fs.writeFile(path.join(dir, 'module_tree.json'), '[]');
      await fs.writeFile(path.join(dir, 'overview.md'), '# overview');
    });

    const enqueued = queue.enqueue(repo, repo.lastCommit);
    await enqueued.done;

    const lifecycle = queue.getLifecycle(repo);
    expect(lifecycle.status).toBe('ready');
    expect(lifecycle.sourceCommit).toBe(repo.lastCommit);

    const publishedMeta = JSON.parse(
      await fs.readFile(path.join(repo.storagePath, 'wiki', 'meta.json'), 'utf-8'),
    );
    expect(publishedMeta.fromCommit).toBe(repo.lastCommit);
    await expect(fs.access(path.join(repo.storagePath, 'wiki', 'overview.md'))).resolves.toBeUndefined();
  });

  it('Neo4j 模式失败：旧 Wiki 保留、状态 failed、无自动重试、显式重入可重跑', async () => {
    mocks.isNeo4jBackendEnabled.mockReturnValue(true);
    const { WikiQueue } = await import('../../src/server/wiki-queue.js');
    const queue = new WikiQueue();
    const repo = await tempRepo();

    await fs.mkdir(path.join(repo.storagePath, 'wiki'), { recursive: true });
    await fs.writeFile(
      path.join(repo.storagePath, 'wiki', 'meta.json'),
      JSON.stringify({ fromCommit: 'b'.repeat(40) }),
    );
    await fs.writeFile(path.join(repo.storagePath, 'wiki', 'overview.md'), '# old');

    mocks.loadMeta.mockResolvedValue({ lastCommit: repo.lastCommit });
    mocks.resolveLLMConfig.mockResolvedValue({ apiKey: 'k', provider: 'openai' });
    mocks.generatorRun.mockRejectedValue(new Error('LLM request timed out'));

    const first = queue.enqueue(repo, repo.lastCommit);
    await expect(first.done).rejects.toThrow('LLM request timed out');

    const lifecycle = queue.getLifecycle(repo);
    expect(lifecycle.status).toBe('failed');
    expect(lifecycle.lastError).toBe('generation_failed');
    expect(mocks.generatorRun).toHaveBeenCalledTimes(1);

    const oldMeta = JSON.parse(
      await fs.readFile(path.join(repo.storagePath, 'wiki', 'meta.json'), 'utf-8'),
    );
    expect(oldMeta.fromCommit).toBe('b'.repeat(40));

    const second = queue.enqueue(repo, repo.lastCommit);
    await expect(second.done).rejects.toThrow('LLM request timed out');
    expect(mocks.generatorRun).toHaveBeenCalledTimes(2);
  });
});
