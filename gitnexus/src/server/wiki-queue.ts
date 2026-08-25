import fs from 'fs/promises';
import path from 'path';
import { canonicalizePath, loadMeta, type RegistryEntry } from '../storage/repo-manager.js';
import { WikiGenerator, type WikiOptions } from '../core/wiki/generator.js';
import { resolveLLMConfig } from '../core/wiki/llm-client.js';
import { logger } from '../core/logger.js';

export type WikiStatus = 'never_generated' | 'queued' | 'running' | 'ready' | 'failed';
export type WikiQueueStatus = 'idle' | 'queued' | 'running';

type WikiErrorCode = 'configuration_unavailable' | 'source_commit_changed' | 'generation_failed';

interface WikiMetaFile {
  fromCommit?: string;
  generatedAt?: string;
}

interface WikiTask {
  key: string;
  repoIdentity: string;
  repoName: string;
  repoPath: string;
  storagePath: string;
  sourceCommit: string;
}

interface PendingTask {
  task: WikiTask;
  resolve: () => void;
  reject: (error: unknown) => void;
  done: Promise<void>;
}

export interface WikiLifecycle {
  enabled: true;
  sourceCommit: string | null;
  status: WikiStatus;
  queue: WikiQueueStatus;
  lastSuccessAt?: string;
  lastError: WikiErrorCode | null;
}

const WIKI_DIR = 'wiki';
const publishTempDir = (storagePath: string): string => path.join(storagePath, '.wiki-staging');
const currentWikiDir = (storagePath: string): string => path.join(storagePath, WIKI_DIR);

const isCommit = (value: string): boolean => /^[0-9a-f]{40}$/i.test(value);

const errorCode = (error: unknown): WikiErrorCode => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('source commit changed')) return 'source_commit_changed';
  if (message.includes('LLM configuration')) return 'configuration_unavailable';
  return 'generation_failed';
};

const readWikiMeta = async (storagePath: string): Promise<WikiMetaFile | null> => {
  try {
    return JSON.parse(await fs.readFile(path.join(currentWikiDir(storagePath), 'meta.json'), 'utf-8'));
  } catch {
    return null;
  }
};

const remove = async (target: string): Promise<void> => {
  await fs.rm(target, { recursive: true, force: true });
};

export class WikiQueue {
  private readonly queued: PendingTask[] = [];
  private readonly pending = new Map<string, PendingTask>();
  private readonly doneByKey = new Map<string, Promise<void>>();
  private readonly active = new Set<string>();
  private readonly lifecycleByIdentity = new Map<string, WikiLifecycle>();
  private running = false;

  enqueue(entry: RegistryEntry, sourceCommit: string): { status: 'accepted' | 'deferred'; done: Promise<void> } {
    const repoIdentity = canonicalizePath(path.resolve(entry.path));
    const key = `${repoIdentity}:${sourceCommit}`;
    const existing = this.pending.get(key);
    const existingDone = this.doneByKey.get(key);
    if (existing || this.active.has(key)) {
      return { status: 'deferred', done: existing?.done ?? existingDone ?? Promise.resolve() };
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const task: WikiTask = {
      key,
      repoIdentity,
      repoName: entry.name,
      repoPath: entry.path,
      storagePath: entry.storagePath,
      sourceCommit,
    };
    const pending: PendingTask = { task, resolve, reject, done };
    this.pending.set(key, pending);
    this.doneByKey.set(key, done);
    this.queued.push(pending);
    this.lifecycleByIdentity.set(repoIdentity, {
      enabled: true,
      sourceCommit,
      status: 'queued',
      queue: 'queued',
      lastError: null,
    });
    void this.drain();
    return { status: 'accepted', done };
  }

  getLifecycle(entry: RegistryEntry): WikiLifecycle {
    const repoIdentity = canonicalizePath(path.resolve(entry.path));
    const tracked = this.lifecycleByIdentity.get(repoIdentity);
    if (tracked) return tracked;
    return {
      enabled: true,
      sourceCommit: null,
      status: 'never_generated',
      queue: 'idle',
      lastError: null,
    };
  }

  async refreshLifecycle(entry: RegistryEntry): Promise<WikiLifecycle> {
    const repoIdentity = canonicalizePath(path.resolve(entry.path));
    const tracked = this.lifecycleByIdentity.get(repoIdentity);
    if (tracked) return tracked;
    const meta = await readWikiMeta(entry.storagePath);
    const ready = meta?.fromCommit === entry.lastCommit;
    return {
      enabled: true,
      sourceCommit: meta?.fromCommit ?? null,
      status: ready ? 'ready' : 'never_generated',
      queue: 'idle',
      ...(ready && meta?.generatedAt ? { lastSuccessAt: meta.generatedAt } : {}),
      lastError: null,
    };
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    const pending = this.queued.shift();
    if (!pending) return;
    this.running = true;
    this.pending.delete(pending.task.key);
    this.active.add(pending.task.key);
    this.lifecycleByIdentity.set(pending.task.repoIdentity, {
      enabled: true,
      sourceCommit: pending.task.sourceCommit,
      status: 'running',
      queue: 'running',
      lastError: null,
    });
    let result: 'ready' | 'up-to-date' | undefined;
    try {
      result = await this.run(pending.task);
      pending.resolve();
    } catch (error) {
      const code = errorCode(error);
      logger.error(
        { err: error, repo: pending.task.repoName, sourceCommit: pending.task.sourceCommit, code },
        'wiki generation failed',
      );
      this.lifecycleByIdentity.set(pending.task.repoIdentity, {
        enabled: true,
        sourceCommit: pending.task.sourceCommit,
        status: 'failed',
        queue: 'idle',
        lastError: code,
      });
      pending.reject(error);
    } finally {
      if (result === 'ready' || result === 'up-to-date') {
        this.markReady(pending.task, (await readWikiMeta(pending.task.storagePath))?.generatedAt);
      }
      this.active.delete(pending.task.key);
      this.doneByKey.delete(pending.task.key);
      this.running = false;
      void this.drain();
    }
  }

  private async run(task: WikiTask): Promise<'ready' | 'up-to-date'> {
    if (!isCommit(task.sourceCommit)) throw new Error('source commit changed');
    const currentMeta = await loadMeta(task.storagePath);
    if (currentMeta?.lastCommit !== task.sourceCommit) throw new Error('source commit changed');

    const existing = await readWikiMeta(task.storagePath);
    if (existing?.fromCommit === task.sourceCommit) {
      return 'up-to-date';
    }

    const llmConfig = await resolveLLMConfig();
    if (!llmConfig.apiKey && !['cursor', 'claude', 'codex', 'opencode'].includes(llmConfig.provider ?? '')) {
      throw new Error('LLM configuration unavailable');
    }

    const stage = path.join(publishTempDir(task.storagePath), task.sourceCommit);
    await remove(stage);
    await fs.mkdir(stage, { recursive: true });
    try {
      const generator = new WikiGenerator(
        task.repoPath,
        task.storagePath,
        path.join(task.storagePath, 'lbug'),
        llmConfig,
        { outputDir: stage, sourceCommit: task.sourceCommit } satisfies WikiOptions,
      );
      await generator.run();
      await this.publish(task, stage);
      return 'ready';
    } catch (error) {
      await remove(stage);
      throw error;
    }
  }

  private async publish(task: WikiTask, stage: string): Promise<void> {
    const sourceMeta = await loadMeta(task.storagePath);
    const stagedMeta = await readWikiMetaFrom(stage);
    if (sourceMeta?.lastCommit !== task.sourceCommit || stagedMeta?.fromCommit !== task.sourceCommit) {
      throw new Error('source commit changed');
    }
    for (const required of ['meta.json', 'module_tree.json', 'overview.md']) {
      await fs.access(path.join(stage, required));
    }

    const live = currentWikiDir(task.storagePath);
    const parent = path.dirname(live);
    const previous = path.join(parent, '.wiki-previous');
    await fs.mkdir(parent, { recursive: true });
    await remove(previous);
    try {
      await fs.rename(live, previous);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await fs.rename(stage, live);
    } catch (error) {
      await fs.rename(previous, live).catch(() => {});
      throw error;
    }
    await remove(previous);
  }

  private markReady(task: WikiTask, generatedAt?: string): void {
    this.lifecycleByIdentity.set(task.repoIdentity, {
      enabled: true,
      sourceCommit: task.sourceCommit,
      status: 'ready',
      queue: 'idle',
      ...(generatedAt ? { lastSuccessAt: generatedAt } : {}),
      lastError: null,
    });
  }
}

const readWikiMetaFrom = async (wikiDir: string): Promise<WikiMetaFile | null> => {
  try {
    return JSON.parse(await fs.readFile(path.join(wikiDir, 'meta.json'), 'utf-8'));
  } catch {
    return null;
  }
};
