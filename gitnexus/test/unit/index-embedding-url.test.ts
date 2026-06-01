import { afterEach, describe, expect, it, vi } from 'vitest';

const mockVec = Array.from({ length: 512 }, (_, i) => i / 512);

describe('index embedding URL override', () => {
  const savedEnv = {
    GITNEXUS_EMBEDDING_URL: process.env.GITNEXUS_EMBEDDING_URL,
    GITNEXUS_EMBEDDING_MODEL: process.env.GITNEXUS_EMBEDDING_MODEL,
    GITNEXUS_EMBEDDING_DIMS: process.env.GITNEXUS_EMBEDDING_DIMS,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('routes scoped embedding calls to index URL and restores the default URL', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'http://search:8001/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
    delete process.env.GITNEXUS_EMBEDDING_DIMS;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: mockVec }] }),
      }),
    );

    const { httpEmbed, withEmbeddingBaseUrl } =
      await import('../../src/core/embeddings/http-client.js');

    await withEmbeddingBaseUrl('http://index:8002/v1', async () => {
      await httpEmbed(['index text']);
    });
    await httpEmbed(['search text']);

    expect((fetch as any).mock.calls[0][0]).toBe('http://index:8002/v1/embeddings');
    expect((fetch as any).mock.calls[1][0]).toBe('http://search:8001/v1/embeddings');
  });
});
