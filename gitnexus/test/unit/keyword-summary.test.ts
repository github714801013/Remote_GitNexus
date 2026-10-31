import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddableNode } from '../../src/core/embeddings/types.js';
import { logger } from '../../src/core/logger.js';

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

const node: EmbeddableNode = {
  id: 'Function:src/order.ts:loadOrder',
  name: 'loadOrder',
  label: 'Function',
  filePath: 'src/order.ts',
  content: 'export function loadOrder(orderId: string) { return db.orders.find(orderId); }',
  startLine: 1,
  endLine: 1,
};

describe('keyword summary', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.mocked(logger.debug).mockClear();
    process.env.GITNEXUS_KEYWORD_SUMMARY_ENABLED = 'true';
    process.env.GITNEXUS_KEYWORD_SUMMARY_URL = 'http://summary.local';
    process.env.GITNEXUS_KEYWORD_SUMMARY_MODEL = 'summary-model';
    process.env.GITNEXUS_KEYWORD_SUMMARY_FAILURE_COOLDOWN_MS = '60000';
    delete process.env.GITNEXUS_KEYWORD_SUMMARY_MAX_TOKENS;
    delete process.env.GITNEXUS_KEYWORD_SUMMARY_CONCURRENCY;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connection timed out');
    }) as any;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('debug-logs keyword summary failures without error stacks and skips repeated calls during cooldown', async () => {
    const { buildKeywordSummaryPrefix } =
      await import('../../src/core/embeddings/keyword-summary.js');

    await expect(buildKeywordSummaryPrefix(node, node.content, 'hash-a')).resolves.toBeUndefined();
    await expect(buildKeywordSummaryPrefix(node, node.content, 'hash-b')).resolves.toBeUndefined();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: 'Error',
        errorMessage: 'connection timed out',
        model: 'summary-model',
        nodeId: node.id,
      }),
      'Keyword summary request failed; temporarily disabling keyword summaries',
    );
    expect(vi.mocked(logger.debug).mock.calls[0]?.[0]).not.toHaveProperty('err');
  });

  it('logs only once when concurrent summary requests fail in the same batch', async () => {
    const { buildKeywordSummaryPrefix } =
      await import('../../src/core/embeddings/keyword-summary.js');

    await Promise.all([
      buildKeywordSummaryPrefix({ ...node, id: `${node.id}#1` }, node.content, 'hash-a'),
      buildKeywordSummaryPrefix({ ...node, id: `${node.id}#2` }, node.content, 'hash-b'),
      buildKeywordSummaryPrefix({ ...node, id: `${node.id}#3` }, node.content, 'hash-c'),
    ]);

    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  it('uses reasoning content when qwen-compatible servers return an empty message content', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '',
              reasoning: JSON.stringify({
                businessKeywords: ['订单查询'],
                technicalKeywords: ['db.orders.find'],
                intent: '根据订单ID读取订单信息',
              }),
            },
          },
        ],
      }),
    })) as any;

    const { buildKeywordSummaryPrefix } =
      await import('../../src/core/embeddings/keyword-summary.js');

    await expect(buildKeywordSummaryPrefix(node, node.content, 'hash-reasoning')).resolves.toBe(
      '[中文业务摘要]\n业务词: 订单查询\n技术词: db.orders.find\n意图: 根据订单ID读取订单信息',
    );
  });

  it('uses configurable max tokens for keyword summary responses', async () => {
    process.env.GITNEXUS_KEYWORD_SUMMARY_MAX_TOKENS = '768';
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                businessKeywords: ['订单查询'],
              }),
            },
          },
        ],
      }),
    })) as any;

    const { buildKeywordSummaryPrefix } =
      await import('../../src/core/embeddings/keyword-summary.js');

    await buildKeywordSummaryPrefix(node, node.content, 'hash-max-tokens');

    const body = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body));
    expect(body.max_tokens).toBe(768);
  });

  it('uses a conservative default summary concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    globalThis.fetch = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ businessKeywords: ['订单查询'] }) } }] }),
      };
    }) as any;

    const { buildKeywordSummaryPrefix } =
      await import('../../src/core/embeddings/keyword-summary.js');

    await Promise.all([
      buildKeywordSummaryPrefix({ ...node, id: `${node.id}#default-1` }, node.content, 'hash-default-1'),
      buildKeywordSummaryPrefix({ ...node, id: `${node.id}#default-2` }, node.content, 'hash-default-2'),
    ]);

    expect(maxActive).toBe(1);
  });
  it('limits concurrent keyword summary requests', async () => {
    process.env.GITNEXUS_KEYWORD_SUMMARY_CONCURRENCY = '1';
    let active = 0;
    let maxActive = 0;
    globalThis.fetch = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  businessKeywords: ['订单查询'],
                }),
              },
            },
          ],
        }),
      };
    }) as any;

    const { buildKeywordSummaryPrefix } =
      await import('../../src/core/embeddings/keyword-summary.js');

    await Promise.all([
      buildKeywordSummaryPrefix({ ...node, id: `${node.id}#1` }, node.content, 'hash-a'),
      buildKeywordSummaryPrefix({ ...node, id: `${node.id}#2` }, node.content, 'hash-b'),
      buildKeywordSummaryPrefix({ ...node, id: `${node.id}#3` }, node.content, 'hash-c'),
    ]);

    expect(maxActive).toBe(1);
  });
});
