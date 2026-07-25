import type { AnalyzeJob, AnalyzeJobProgress, JobManager } from './analyze-job.js';

const TERMINAL_STATUSES = new Set<AnalyzeJob['status']>(['complete', 'failed']);

export const waitForJobManagerIdle = async (jobManager: JobManager): Promise<void> => {
  while (true) {
    const active = jobManager.listJobs().find((job) => !TERMINAL_STATUSES.has(job.status));
    if (!active) return;
    await waitForTerminalJob(jobManager, active.id);
  }
};

const waitForTerminalJob = (jobManager: JobManager, jobId: string): Promise<void> =>
  new Promise((resolve) => {
    const current = jobManager.getJob(jobId);
    if (!current || TERMINAL_STATUSES.has(current.status)) {
      resolve();
      return;
    }

    const unsubscribe = jobManager.onProgress(jobId, (progress: AnalyzeJobProgress) => {
      if (progress.phase === 'complete' || progress.phase === 'failed') {
        unsubscribe();
        resolve();
      }
    });

    const afterSubscribe = jobManager.getJob(jobId);
    if (!afterSubscribe || TERMINAL_STATUSES.has(afterSubscribe.status)) {
      unsubscribe();
      resolve();
    }
  });
