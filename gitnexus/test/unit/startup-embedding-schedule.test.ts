import { afterEach, describe, expect, it, vi } from 'vitest';

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
});
