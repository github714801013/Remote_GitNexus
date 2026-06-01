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

type NumberProvider = number | (() => number);

interface WebhookAnalyzeQueueOptions {
  startStaggerMs?: NumberProvider;
  now?: () => number;
  startGate?: WebhookStartStaggerGate;
}

export class WebhookStartStaggerGate {
  private activeCount = 0;
  private lastStartedAt: number | null = null;

  constructor(
    private readonly startStaggerMs: NumberProvider = 0,
    private readonly now: () => number = Date.now,
  ) {}

  getDelayMs(): number {
    if (this.activeCount === 0 || this.lastStartedAt === null) return 0;
    const staggerMs = this.getStartStaggerMs();
    if (staggerMs <= 0) return 0;
    return Math.max(0, staggerMs - (this.now() - this.lastStartedAt));
  }

  markStarted(): void {
    this.activeCount += 1;
    this.lastStartedAt = this.now();
  }

  markFinished(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
  }

  private getStartStaggerMs(): number {
    const value =
      typeof this.startStaggerMs === 'function' ? this.startStaggerMs() : this.startStaggerMs;
    return Number.isFinite(value) && value !== undefined && value > 0 ? Math.trunc(value) : 0;
  }
}

export class WebhookAnalyzeQueue {
  private readonly activeKeys = new Set<string>();
  private readonly pendingByKey = new Map<string, PendingTask>();
  private readonly queue: PendingTask[] = [];
  private readonly startGate: WebhookStartStaggerGate;
  private running = 0;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly concurrency: NumberProvider = 1,
    options: WebhookAnalyzeQueueOptions = {},
  ) {
    this.startGate =
      options.startGate ??
      new WebhookStartStaggerGate(options.startStaggerMs ?? 0, options.now ?? Date.now);
  }

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
    if (this.drainTimer) {
      if (this.getStartDelayMs() <= 0) {
        clearTimeout(this.drainTimer);
        this.drainTimer = null;
      } else {
        return;
      }
    }

    while (this.running < this.getConcurrency() && this.queue.length > 0) {
      const startDelayMs = this.getStartDelayMs();
      if (startDelayMs > 0) {
        this.scheduleDrain(startDelayMs);
        return;
      }
      const pending = this.queue.shift();
      if (!pending) return;
      void this.run(pending);
    }
  }

  private getConcurrency(): number {
    const value = typeof this.concurrency === 'function' ? this.concurrency() : this.concurrency;
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 1;
  }

  private getStartDelayMs(): number {
    return this.startGate.getDelayMs();
  }

  private scheduleDrain(delayMs: number): void {
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drain();
    }, delayMs);
  }

  private async run(pending: PendingTask): Promise<void> {
    const key = pending.task.key;
    this.running += 1;
    this.startGate.markStarted();
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
      this.startGate.markFinished();
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
