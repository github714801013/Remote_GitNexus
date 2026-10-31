import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddableNode } from '../../src/core/embeddings/types.js';

const buildKeywordSummaryPrefix = vi.fn(
  async () => '[中文业务摘要]\n业务词: 订单查询\n意图: 根据订单ID读取订单',
);

vi.mock('../../src/core/embeddings/keyword-summary.js', () => ({
  buildKeywordSummaryPrefix,
}));

describe('Neo4j embedding text', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.GITNEXUS_EMBEDDING_TEXT_MAX_CHARS;
  });

  it('places generated keyword summary before code in the text sent to embedding', async () => {
    const { buildNeo4jEmbeddingText } = await import('../../src/server/neo4j-embedding-text.js');
    const node: EmbeddableNode = {
      id: 'Function:src/order.ts:loadOrder',
      name: 'loadOrder',
      label: 'Function',
      filePath: 'src/order.ts',
      content: 'export function loadOrder(orderId: string) {\n  return db.orders.find(orderId);\n}',
      startLine: 1,
      endLine: 3,
      description: '读取订单信息',
      isExported: true,
    };

    const result = await buildNeo4jEmbeddingText(node, 'hash-a');

    expect(result.summaryText).toBe('[中文业务摘要]\n业务词: 订单查询\n意图: 根据订单ID读取订单');
    expect(result.embeddingText).toContain('[中文业务摘要]');
    expect(result.embeddingText).toContain('读取订单信息');
    expect(result.embeddingText.indexOf('[中文业务摘要]')).toBeLessThan(
      result.embeddingText.indexOf('export function loadOrder'),
    );
    expect(buildKeywordSummaryPrefix).toHaveBeenCalledWith(
      node,
      expect.stringContaining('读取订单信息'),
      'hash-a',
    );
  });

  it('caps the final embedding text to avoid sending huge code bodies to the embedding endpoint', async () => {
    process.env.GITNEXUS_EMBEDDING_TEXT_MAX_CHARS = '1200';
    const { buildNeo4jEmbeddingText } = await import('../../src/server/neo4j-embedding-text.js');
    const node: EmbeddableNode = {
      id: 'Method:src/huge.ts:BigService.run',
      name: 'BigService.run',
      label: 'Method',
      filePath: 'src/huge.ts',
      content: `export function run() {\n${'  doWork();\n'.repeat(1000)}}`,
      startLine: 1,
      endLine: 1002,
      description: '执行大批量业务逻辑',
      isExported: true,
    };

    const result = await buildNeo4jEmbeddingText(node, 'hash-b');

    expect(result.embeddingText.length).toBeLessThanOrEqual(1200);
    expect(result.embeddingText).toContain('[中文业务摘要]');
    expect(result.embeddingText).toContain('执行大批量业务逻辑');
  });
});
