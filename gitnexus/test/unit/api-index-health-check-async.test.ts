import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('POST /api/index-health-check async contract', () => {
  it('queues the health check and returns accepted without awaiting the loop', async () => {
    const source = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'server', 'api.ts'),
      'utf8',
    );
    const routeStart = source.indexOf("app.post('/api/index-health-check'");
    const routeEnd = source.indexOf('\n\n  /**', routeStart);
    const route = source.slice(routeStart, routeEnd);

    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(routeEnd).toBeGreaterThan(routeStart);
    expect(route).toContain("void runIndexHealthCheck('manual')");
    expect(route).toMatch(/res\.status\(202\)\.json\([\s\S]*accepted:\s*true/);
    expect(route).not.toContain('await runIndexHealthCheck');
  });

  it('reconciles missing webhook targets inside the health check', async () => {
    const source = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'server', 'api.ts'),
      'utf8',
    );
    const loopStart = source.indexOf('const runIndexHealthCheck = async');
    const loopEnd = source.indexOf("app.post('/api/index-health-check'", loopStart);
    const loop = source.slice(loopStart, loopEnd);

    expect(loopStart).toBeGreaterThanOrEqual(0);
    expect(loopEnd).toBeGreaterThan(loopStart);
    expect(loop).toContain('reconcileMissingWebhookTargets(webhookTargets');
    expect(loop).toContain('enqueue: enqueueWebhookTarget');
    expect(loop).toContain(
      'shouldReconcileMissingWebhookTargets(source, shouldScheduleStartupWebhookRepos())',
    );
  });

  it('restores a mismatched main checkout to its index branch before scheduling', async () => {
    const source = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'server', 'api.ts'),
      'utf8',
    );
    const loopStart = source.indexOf('const runIndexHealthCheck = async');
    const loopEnd = source.indexOf("app.post('/api/index-health-check'", loopStart);
    const loop = source.slice(loopStart, loopEnd);

    expect(loopStart).toBeGreaterThanOrEqual(0);
    expect(loopEnd).toBeGreaterThan(loopStart);
    expect(loop).toContain('mainCloneUrlByPath');
    expect(loop).toContain('restoreIndexBranch(');
    expect(loop).toContain('checkStaleness: checkStalenessAsync');
  });
});
