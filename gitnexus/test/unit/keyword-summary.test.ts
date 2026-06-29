import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildKeywordSummaryPrefix,
  clearKeywordSummaryCacheForTests,
  getKeywordSummaryHashSalt,
  getKeywordSummaryLanguage,
  shouldSummarizeNode,
} from '../../src/core/embeddings/keyword-summary.js';
import type { EmbeddableNode } from '../../src/core/embeddings/types.js';

const originalEnv = { ...process.env };

const makeNode = (overrides: Partial<EmbeddableNode> = {}): EmbeddableNode => ({
  id: 'Function:refund:src/refund.ts',
  name: 'getRefundRate',
  label: 'Function',
  filePath: 'src/refund.ts',
  content: 'function getRefundRate(orders) { return orders.filter(o => o.refunded).length; }',
  ...overrides,
});

describe('keyword-summary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    clearKeywordSummaryCacheForTests();
  });

  it('is disabled by default', () => {
    expect(shouldSummarizeNode(makeNode())).toBe(false);
    expect(getKeywordSummaryHashSalt()).toBe('keyword-summary:off');
  });

  it('skips short nodes even when enabled', () => {
    process.env.GITNEXUS_KEYWORD_SUMMARY_ENABLED = 'true';
    expect(shouldSummarizeNode(makeNode({ label: 'Const' }))).toBe(false);
  });

  it('skips nodes with empty or trivially short content even when enabled', () => {
    process.env.GITNEXUS_KEYWORD_SUMMARY_ENABLED = 'true';
    // content missing entirely (common when ingestion has not populated it)
    expect(shouldSummarizeNode(makeNode({ content: '' }))).toBe(false);
    // whitespace-only
    expect(shouldSummarizeNode(makeNode({ content: '   \n\t  ' }))).toBe(false);
    // very short body — below the MIN_SUMMARY_CONTENT_CHARS threshold
    expect(shouldSummarizeNode(makeNode({ content: 'function f(){}' }))).toBe(false);
    // real-length body still summarized
    expect(
      shouldSummarizeNode(
        makeNode({
          content: 'function getRefundRate(orders) { return orders.filter(o => o.refunded); }',
        }),
      ),
    ).toBe(true);
  });

  it('extracts fenced JSON and formats Chinese business keywords first', async () => {
    process.env.GITNEXUS_KEYWORD_SUMMARY_ENABLED = 'true';
    process.env.GITNEXUS_KEYWORD_SUMMARY_URL = 'http://keyword-summary:8080/v1';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '```json\n{"businessKeywords":["退款率","订单退款"],"technicalKeywords":["filter","length"],"intent":"计算订单退款率","aliases":["退款比例"]}\n```',
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await buildKeywordSummaryPrefix(makeNode(), 'Function: getRefundRate', 'hash1');

    expect(summary).toContain('[中文业务摘要]');
    expect(summary).toContain('业务词: 退款率, 订单退款');
    expect(summary).toContain('技术词: filter, length');
    expect(summary).toContain('意图: 计算订单退款率');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://keyword-summary:8080/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.messages[0].content).toContain('摘要输出语言: 中文');
    expect(requestBody.messages[0].content).toContain(
      'businessKeywords 必须优先使用摘要输出语言里的业务词',
    );
    expect(requestBody.messages[0].content).toContain('证据不足时不要猜测不存在的业务');
    expect(requestBody.messages[0].content).toContain('Mapper XML 或 SQL');
    expect(requestBody.messages[0].content).toContain('签名级/声明级');
  });

  it('uses configured summary language in prompt, output header, and hash salt', async () => {
    process.env.GITNEXUS_KEYWORD_SUMMARY_ENABLED = 'true';
    process.env.GITNEXUS_KEYWORD_SUMMARY_URL = 'http://keyword-summary:8080/v1';
    process.env.GITNEXUS_KEYWORD_SUMMARY_LANGUAGE = 'English';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '{"businessKeywords":["refund rate"],"technicalKeywords":["filter"],"intent":"calculate refund rate","aliases":["refund ratio"]}',
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await buildKeywordSummaryPrefix(makeNode(), 'Function: getRefundRate', 'hash1');

    expect(getKeywordSummaryLanguage()).toBe('English');
    expect(getKeywordSummaryHashSalt()).toBe('keyword-summary:zh-business-keywords-v2:English');
    expect(summary).toContain('[English业务摘要]');
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.messages[0].content).toContain('摘要输出语言: English');
  });

  it('returns undefined when the service fails', async () => {
    process.env.GITNEXUS_KEYWORD_SUMMARY_ENABLED = 'true';
    process.env.GITNEXUS_KEYWORD_SUMMARY_URL = 'http://keyword-summary:8080/v1';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    await expect(
      buildKeywordSummaryPrefix(makeNode(), 'Function: getRefundRate', 'hash1'),
    ).resolves.toBeUndefined();
  });
});
