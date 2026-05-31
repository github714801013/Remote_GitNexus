export type WebhookAnalyzeStatus = 'accepted' | 'deferred';
export type ReleaseWebhookAnalyzeSlot = () => void;

export interface WebhookAnalyzeTask {
  key: string;
  run: (releaseStructureSlot: ReleaseWebhookAnalyzeSlot) => Promise<void>;
}

export interface WebhookAnalyzeQueueResult {
  status: WebhookAnalyzeStatus;
  done: Promise<void>;
}

interface PendingTask {
  task: WebhookAnalyzeTask;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class WebhookAnalyzeQueue {
  private readonly activeKeys = new Set<string>();
  private readonly pendingByKey = new Map<string, PendingTask>();
  private readonly queue: PendingTask[] = [];
  private running = 0;

  constructor(private readonly concurrency = 1) {}

  enqueue(task: WebhookAnalyzeTask): WebhookAnalyzeQueueResult {
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const pending: PendingTask = { task, resolve, reject };

    if (this.activeKeys.has(task.key) || this.pendingByKey.has(task.key)) {
      const existing = this.pendingByKey.get(task.key);
      if (existing) {
        existing.task = task;
        return { status: 'deferred', done: existingDone(existing) };
      }
      this.pendingByKey.set(task.key, pending);
      return { status: 'deferred', done };
    }

    this.queue.push(pending);
    this.drain();
    return { status: 'accepted', done };
  }

  private drain(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const pending = this.queue.shift();
      if (!pending) return;
      void this.run(pending);
    }
  }

  private async run(pending: PendingTask): Promise<void> {
    const key = pending.task.key;
    this.running += 1;
    this.activeKeys.add(key);
    let structureSlotReleased = false;
    const releaseStructureSlot = () => {
      if (structureSlotReleased) return;
      structureSlotReleased = true;
      this.running -= 1;
      this.drain();
    };
    const markStructureSlotReleased = () => {
      if (structureSlotReleased) return;
      structureSlotReleased = true;
      this.running -= 1;
    };
    try {
      await pending.task.run(releaseStructureSlot);
      pending.resolve();
    } catch (err) {
      pending.reject(err);
    } finally {
      this.activeKeys.delete(key);
      markStructureSlotReleased();

      const nextForKey = this.pendingByKey.get(key);
      if (nextForKey) {
        this.pendingByKey.delete(key);
        this.queue.unshift(nextForKey);
      }
      this.drain();
    }
  }
}

const existingDone = (pending: PendingTask): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const prevResolve = pending.resolve;
    const prevReject = pending.reject;
    pending.resolve = () => {
      prevResolve();
      resolve();
    };
    pending.reject = (err) => {
      prevReject(err);
      reject(err);
    };
  });
