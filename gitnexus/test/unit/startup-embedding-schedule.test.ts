import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

vi.mock('@ladybugdb/core', () => ({
  default: {},
}));

import { shouldScheduleStartupEmbeddings } from '../../src/server/api.js';

describe('startup embedding schedule', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('schedules embedding repair when keyword summary hash salt changed', () => {
    vi.stubEnv('GITNEXUS_KEYWORD_SUMMARY_REPAIR_EXISTING_EMBEDDINGS', 'true');

    expect(
      shouldScheduleStartupEmbeddings(
        {
          embeddingStatus: 'complete',
          indexedAt: new Date().toISOString(),
          stats: { nodes: 10, embeddings: 10 },
          keywordSummaryHashSalt: 'keyword-summary:off',
        },
        10,
        'keyword-summary:zh-business-keywords-v2:中文',
      ),
    ).toBe(true);
  });

  it('schedules legacy completed embeddings that do not have an embeddingStatus stamp', () => {
    vi.stubEnv('GITNEXUS_KEYWORD_SUMMARY_REPAIR_EXISTING_EMBEDDINGS', 'true');

    expect(
      shouldScheduleStartupEmbeddings(
        {
          indexedAt: new Date().toISOString(),
          stats: { nodes: 10, embeddings: 10 },
        },
        10,
        'keyword-summary:zh-business-keywords-v2:中文',
      ),
    ).toBe(true);
  });

  it('does not automatically reschedule existing embeddings for keyword summaries by default', () => {
    expect(
      shouldScheduleStartupEmbeddings(
        {
          indexedAt: new Date().toISOString(),
          stats: { nodes: 10, embeddings: 10 },
        },
        10,
        'keyword-summary:zh-business-keywords-v2:中文',
      ),
    ).toBe(false);
  });

  it('does not reschedule complete embeddings when the keyword summary hash salt matches', () => {
    vi.stubEnv('GITNEXUS_KEYWORD_SUMMARY_REPAIR_EXISTING_EMBEDDINGS', 'true');

    expect(
      shouldScheduleStartupEmbeddings(
        {
          embeddingStatus: 'complete',
          indexedAt: new Date().toISOString(),
          stats: { nodes: 10, embeddings: 10 },
          keywordSummaryHashSalt: 'keyword-summary:zh-business-keywords-v2:中文',
        },
        10,
        'keyword-summary:zh-business-keywords-v2:中文',
      ),
    ).toBe(false);
  });

  it('keeps stale structure repair and Neo4j embedding repair as independent startup schedules', async () => {
    const source = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'server', 'api.ts'),
      'utf-8',
    );
    const repairPosition = source.indexOf('if (isNeo4jBackendEnabled() && needsEmbeddings)');
    const stalePosition = source.indexOf('if (shouldScheduleStartupIncrementalAnalyze(staleness))');

    expect(repairPosition).toBeGreaterThanOrEqual(0);
    expect(stalePosition).toBeGreaterThan(repairPosition);
    expect(source.slice(repairPosition, stalePosition)).toMatch(
      /startEmbeddingRepairForEntry\(entry, \{ source, registryBranch \}\)/,
    );
    expect(source.slice(stalePosition)).toMatch(/scheduleStaleAnalyze\(\);\n          continue;/);
  });

  it('does not make Neo4j embedding repair acquire the structure/Ladybug repository lock', async () => {
    const source = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'server', 'api.ts'),
      'utf-8',
    );
    const start = source.indexOf('const startEmbeddingRepairForEntry =');
    const end = source.indexOf('const storagePath = repoLockKey', start);
    const neo4jRepair = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(neo4jRepair).toMatch(/if \(isNeo4jBackendEnabled\(\)\) \{/);
    expect(neo4jRepair).not.toMatch(/acquireRepoLock|withLbugDb/);
  });

  it('uses the Neo4j repository name rather than the Ladybug storage path as repair identity', async () => {
    const source = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'server', 'api.ts'),
      'utf-8',
    );
    const start = source.indexOf('const startEmbeddingRepairForEntry =');
    const end = source.indexOf('const storagePath = repoLockKey', start);
    const neo4jRepair = source.slice(start, end);

    expect(neo4jRepair).toMatch(/embeddingRepairRequests\.set\(entry\.name/);
    expect(neo4jRepair).toMatch(/repo: entry\.name/);
  });
});
