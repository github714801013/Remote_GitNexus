export type EmbeddingRepairSource = 'startup' | 'manual' | 'finalization';
export type EmbeddingRepairStatus = 'queued' | 'waiting_for_lock' | 'running' | 'failed';

export interface EmbeddingRepairRequest {
  repo: string;
  source: EmbeddingRepairSource;
}

export interface EmbeddingRepairRound {
  repo: string;
  source: EmbeddingRepairSource;
  round: number;
}

export interface EmbeddingRepairProjection extends EmbeddingRepairRound {
  attempt: number;
  status: EmbeddingRepairStatus;
  updatedAt: string;
}

export interface EmbeddingRepairCoordinatorDependencies {
  queue: {
    enqueue(repo: string, task: () => Promise<void>): void;
  };
  runner: {
    run(repo: string): Promise<void>;
  };
  lock: {
    tryAcquire(repo: string): boolean;
    release(repo: string): void;
    onReleased(listener: (repo: string) => void): () => void;
  };
  timers: {
    setTimeout(task: () => void, delayMs: number): unknown;
  };
  now(): string;
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 2_000];

export interface EmbeddingRepairCoordinator {
  request(request: EmbeddingRepairRequest): EmbeddingRepairProjection;
  get(repo: string): EmbeddingRepairProjection | undefined;
}

export const createEmbeddingRepairCoordinator = (
  dependencies: EmbeddingRepairCoordinatorDependencies,
): EmbeddingRepairCoordinator => {
  const activeRounds = new Map<string, EmbeddingRepairProjection>();
  const failedRounds = new Map<string, EmbeddingRepairProjection>();
  const roundCounts = new Map<string, number>();
  const scheduledRepos = new Set<string>();
  const waitingRepos = new Set<string>();

  const project = (
    round: EmbeddingRepairProjection,
    status: EmbeddingRepairStatus,
    attempt = round.attempt,
  ): EmbeddingRepairProjection => ({
    ...round,
    attempt,
    status,
    updatedAt: dependencies.now(),
  });

  const enqueue = (repo: string): void => {
    if (scheduledRepos.has(repo)) return;
    scheduledRepos.add(repo);
    dependencies.queue.enqueue(repo, async () => {
      scheduledRepos.delete(repo);
      const round = activeRounds.get(repo);
      if (!round) return;

      if (!dependencies.lock.tryAcquire(repo)) {
        waitingRepos.add(repo);
        activeRounds.set(repo, project(round, 'waiting_for_lock'));
        return;
      }

      waitingRepos.delete(repo);
      const running = project(round, 'running', round.attempt + 1);
      activeRounds.set(repo, running);
      try {
        await dependencies.runner.run(repo);
        activeRounds.delete(repo);
        failedRounds.delete(repo);
        waitingRepos.delete(repo);
      } catch (err) {
        if (running.attempt === MAX_ATTEMPTS) {
          activeRounds.delete(repo);
          waitingRepos.delete(repo);
          failedRounds.set(repo, project(running, 'failed'));
          throw err;
        }

        activeRounds.set(repo, project(running, 'queued'));
        dependencies.timers.setTimeout(
          () => enqueue(repo),
          RETRY_DELAYS_MS[running.attempt - 1],
        );
      } finally {
        dependencies.lock.release(repo);
      }
    });
  };

  dependencies.lock.onReleased((repo) => {
    if (waitingRepos.delete(repo)) enqueue(repo);
  });

  return {
    request(request) {
      const active = activeRounds.get(request.repo);
      if (active) return active;

      const failed = failedRounds.get(request.repo);
      if (failed && request.source === 'finalization') return failed;

      const round = (roundCounts.get(request.repo) ?? 0) + 1;
      roundCounts.set(request.repo, round);
      const queued: EmbeddingRepairProjection = {
        ...request,
        round,
        attempt: 0,
        status: 'queued',
        updatedAt: dependencies.now(),
      };
      activeRounds.set(request.repo, queued);
      failedRounds.delete(request.repo);
      enqueue(request.repo);
      return queued;
    },
    get(repo) {
      return activeRounds.get(repo) ?? failedRounds.get(repo);
    },
  };
};
