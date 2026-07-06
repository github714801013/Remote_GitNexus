import { describe, expect, it } from 'vitest';
import { JobManager } from '../../src/server/analyze-job.js';
import { waitForJobManagerIdle } from '../../src/server/analyze-job-wait.js';

describe('waitForJobManagerIdle', () => {
  it('waits until the active JobManager task reaches a terminal state', async () => {
    const manager = new JobManager();
    const job = manager.createJob({ repoPath: '/repo-a' });
    manager.updateJob(job.id, { status: 'analyzing' });

    let settled = false;
    const idle = waitForJobManagerIdle(manager).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    manager.updateJob(job.id, { status: 'complete' });
    await idle;
    expect(settled).toBe(true);

    manager.dispose();
  });
});
