import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddableNode } from '../../src/core/embeddings/types.js';

vi.mock('@ladybugdb/core', () => ({
  default: {},
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  createVectorIndex: vi.fn(),
  loadVectorExtension: vi.fn(),
}));

const makeNode = (): EmbeddableNode => ({
  id: 'Function:foo:src/main.ts',
  name: 'foo',
  label: 'Function',
  filePath: 'src/main.ts',
  content: 'function foo() { return 1; }',
});

describe('contentHashForNode keyword summary salt', () => {
  const originalEnabled = process.env.GITNEXUS_KEYWORD_SUMMARY_ENABLED;
  const originalLanguage = process.env.GITNEXUS_KEYWORD_SUMMARY_LANGUAGE;

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.GITNEXUS_KEYWORD_SUMMARY_ENABLED;
    else process.env.GITNEXUS_KEYWORD_SUMMARY_ENABLED = originalEnabled;
    if (originalLanguage === undefined) delete process.env.GITNEXUS_KEYWORD_SUMMARY_LANGUAGE;
    else process.env.GITNEXUS_KEYWORD_SUMMARY_LANGUAGE = originalLanguage;
  });

  it('changes when keyword summary embedding is enabled or its language changes', async () => {
    const { contentHashForNode } = await import('../../src/core/embeddings/embedding-pipeline.js');
    const node = makeNode();

    delete process.env.GITNEXUS_KEYWORD_SUMMARY_ENABLED;
    delete process.env.GITNEXUS_KEYWORD_SUMMARY_LANGUAGE;
    const disabledHash = contentHashForNode(node);

    process.env.GITNEXUS_KEYWORD_SUMMARY_ENABLED = 'true';
    process.env.GITNEXUS_KEYWORD_SUMMARY_LANGUAGE = '中文';
    const zhHash = contentHashForNode(node);

    process.env.GITNEXUS_KEYWORD_SUMMARY_LANGUAGE = 'English';
    const englishHash = contentHashForNode(node);

    expect(zhHash).not.toBe(disabledHash);
    expect(englishHash).not.toBe(zhHash);
  });
});
