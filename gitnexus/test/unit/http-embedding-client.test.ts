import { afterEach, describe, expect, it, vi } from 'vitest';

const resilientFetchMock = vi.fn();

vi.mock('gitnexus-shared', () => ({
  CircuitOpenError: class CircuitOpenError extends Error {
    retryAfterMs = 1000;
  },
  ResilientFetchExhaustedError: class ResilientFetchExhaustedError extends Error {
    response = { status: 500 };
  },
  resilientFetch: resilientFetchMock,
}));

describe('HTTP embedding client', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('uses GITNEXUS_EMBEDDING_TIMEOUT_MS for request timeout errors', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'http://embedding.local';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'embedding-model';
    process.env.GITNEXUS_EMBEDDING_DIMS = '2';
    process.env.GITNEXUS_EMBEDDING_TIMEOUT_MS = '3600000';
    resilientFetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));

    const { httpEmbed } = await import('../../src/core/embeddings/http-client.js');

    await expect(httpEmbed(['hello'])).rejects.toThrow(
      'Embedding request timed out after 3600000ms (http://embedding.local/embeddings, batch 0)',
    );
  });

  it('lets GITNEXUS_EMBEDDING_REQUEST_TIMEOUT_MS override the shared timeout', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'http://embedding.local';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'embedding-model';
    process.env.GITNEXUS_EMBEDDING_DIMS = '2';
    process.env.GITNEXUS_EMBEDDING_TIMEOUT_MS = '3600000';
    process.env.GITNEXUS_EMBEDDING_REQUEST_TIMEOUT_MS = '120000';
    resilientFetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));

    const { httpEmbedQuery } = await import('../../src/core/embeddings/http-client.js');

    await expect(httpEmbedQuery('hello')).rejects.toThrow(
      'Embedding request timed out after 120000ms (http://embedding.local/embeddings, batch 0)',
    );
  });
});
