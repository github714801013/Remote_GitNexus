/**
 * HTTP Embedding Client
 *
 * Shared fetch+retry logic for OpenAI-compatible /v1/embeddings endpoints.
 * Imported by both the core embedder (batch) and MCP embedder (query).
 */

import { AsyncLocalStorage } from 'async_hooks';

const embeddingUrlOverride = new AsyncLocalStorage<string>();

const readPositiveInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const HTTP_TIMEOUT_MS = readPositiveInt(process.env.GITNEXUS_EMBEDDING_TIMEOUT_MS, 3_600_000);
const HTTP_MAX_RETRIES = 2;
const HTTP_RETRY_BACKOFF_MS = 1_000;
const HTTP_BATCH_SIZE = 64;
// 并发发送的 batch 数量，充分利用多实例 vLLM / nginx LB
const HTTP_CONCURRENCY = readPositiveInt(process.env.GITNEXUS_EMBEDDING_CONCURRENCY, 4);
const DEFAULT_DIMS = 512;

interface HttpConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  dimensions?: number;
}

/**
 * Build config from the current process.env snapshot.
 * Returns null when GITNEXUS_EMBEDDING_URL + GITNEXUS_EMBEDDING_MODEL are unset.
 * Not cached — env vars are read fresh so late configuration takes effect.
 */
const readConfig = (): HttpConfig | null => {
  const baseUrl = embeddingUrlOverride.getStore() ?? process.env.GITNEXUS_EMBEDDING_URL;
  const model = process.env.GITNEXUS_EMBEDDING_MODEL;
  if (!baseUrl || !model) return null;

  const rawDims = process.env.GITNEXUS_EMBEDDING_DIMS;
  let dimensions: number | undefined;
  if (rawDims !== undefined) {
    const parsed = parseInt(rawDims, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new Error(`GITNEXUS_EMBEDDING_DIMS must be a positive integer, got "${rawDims}"`);
    }
    dimensions = parsed;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKey: process.env.GITNEXUS_EMBEDDING_API_KEY ?? 'unused',
    dimensions,
  };
};

/**
 * Check whether HTTP embedding mode is active (env vars are set).
 */
export const isHttpMode = (): boolean => readConfig() !== null;

export const withEmbeddingBaseUrl = async <T>(
  baseUrl: string | undefined,
  fn: () => Promise<T>,
): Promise<T> => {
  if (!baseUrl) return await fn();
  return await embeddingUrlOverride.run(baseUrl, fn);
};

/**
 * Return the configured embedding dimensions for HTTP mode, or undefined
 * if HTTP mode is not active or no explicit dimensions are set.
 */
export const getHttpDimensions = (): number | undefined => readConfig()?.dimensions;

/**
 * Return a safe representation of a URL for error messages.
 * Strips query string (may contain tokens) and userinfo.
 */
const safeUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
};

interface EmbeddingItem {
  embedding: number[];
}

/**
 * Send a single batch of texts to the embedding endpoint with retry.
 *
 * @param url - Full endpoint URL (e.g. https://host/v1/embeddings)
 * @param batch - Texts to embed
 * @param model - Model name for the request body
 * @param apiKey - Bearer token (only used in Authorization header)
 * @param batchIndex - Logical batch number (for error context)
 * @param attempt - Current retry attempt (internal)
 */
const httpEmbedBatch = async (
  url: string,
  batch: string[],
  model: string,
  apiKey: string,
  dimensions: number | undefined,
  batchIndex = 0,
  attempt = 0,
): Promise<EmbeddingItem[]> => {
  let resp: Response;
  const body = {
    input: batch,
    model,
    encoding_format: 'float',
    ...(dimensions === undefined ? {} : { dimensions }),
  };

  try {
    resp = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // ... (rest of error handling remains same)
    const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
    if (isTimeout) {
      throw new Error(
        `Embedding request timed out after ${HTTP_TIMEOUT_MS}ms (${safeUrl(url)}, batch ${batchIndex})`,
      );
    }
    if (attempt < HTTP_MAX_RETRIES) {
      const delay = HTTP_RETRY_BACKOFF_MS * (attempt + 1);
      await new Promise((r) => setTimeout(r, delay));
      return httpEmbedBatch(url, batch, model, apiKey, dimensions, batchIndex, attempt + 1);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Embedding request failed (${safeUrl(url)}, batch ${batchIndex}): ${reason}`);
  }

  if (!resp.ok) {
    const status = resp.status;
    let errorDetail = '';
    try {
      errorDetail = await resp.text();
    } catch {
      // ignore
    }

    console.error(`❌ HTTP Embedding 400 Debug Info:`);
    console.error(`URL: ${url}`);
    console.error(`Status: ${status}`);
    console.error(`Batch Size: ${batch.length}`);
    console.error(`Total Chars: ${batch.reduce((sum, s) => sum + s.length, 0)}`);
    console.error(
      `First 100 chars of first text: "${batch[0]?.substring(0, 100).replace(/\n/g, '\\n')}"`,
    );
    console.error(`Error Response Body: ${errorDetail}`);

    if ((status === 429 || status >= 500) && attempt < HTTP_MAX_RETRIES) {
      const delay = HTTP_RETRY_BACKOFF_MS * (attempt + 1);
      await new Promise((r) => setTimeout(r, delay));
      return httpEmbedBatch(url, batch, model, apiKey, dimensions, batchIndex, attempt + 1);
    }
    throw new Error(`Embedding endpoint returned ${status} (${safeUrl(url)}, batch ${batchIndex})`);
  }

  let data: { data: EmbeddingItem[] } | null = null;
  let text = '';
  if (typeof resp.text === 'function') {
    text = await resp.text();
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `Embedding API returned invalid JSON. Expected embeddings but got: ${text.slice(0, 500).replace(/\n/g, '\\n')}`,
      );
    }
  } else if (typeof (resp as any).json === 'function') {
    data = await (resp as any).json();
    text = JSON.stringify(data);
  } else {
    throw new Error('Embedding API returned success status but response body is not readable');
  }

  if (!data || !data.data) {
    throw new Error(
      `Embedding API returned success status but missing data property. Raw response: ${text.slice(0, 500).replace(/\n/g, '\\n')}`,
    );
  }

  return data.data;
};

/**
 * Embed texts via the HTTP backend, splitting into batches.
 * Reads config from env vars on every call.
 *
 * @param texts - Array of texts to embed
 * @returns Array of Float32Array embedding vectors
 */
export const httpEmbed = async (texts: string[]): Promise<Float32Array[]> => {
  if (texts.length === 0) return [];

  const config = readConfig();
  if (!config) throw new Error('HTTP embedding not configured');

  const url = `${config.baseUrl}/embeddings`;
  const expected = config.dimensions ?? DEFAULT_DIMS;

  // Split into batches, preserving original order via index
  const batches: Array<{ texts: string[]; offset: number; batchIndex: number }> = [];
  for (let i = 0; i < texts.length; i += HTTP_BATCH_SIZE) {
    batches.push({
      texts: texts.slice(i, i + HTTP_BATCH_SIZE),
      offset: i,
      batchIndex: Math.floor(i / HTTP_BATCH_SIZE),
    });
  }

  const allVectors: Float32Array[] = new Array(texts.length);

  const processBatch = async (b: { texts: string[]; offset: number; batchIndex: number }) => {
    const items = await httpEmbedBatch(
      url,
      b.texts,
      config.model,
      config.apiKey,
      config.dimensions,
      b.batchIndex,
    );
    if (items.length !== b.texts.length) {
      throw new Error(
        `Embedding endpoint returned ${items.length} vectors for ${b.texts.length} texts ` +
          `(${safeUrl(url)}, batch ${b.batchIndex})`,
      );
    }
    for (let j = 0; j < items.length; j++) {
      const vec = new Float32Array(items[j].embedding);
      if (vec.length !== expected) {
        const hint = config.dimensions
          ? 'Update GITNEXUS_EMBEDDING_DIMS to match your model output.'
          : `Set GITNEXUS_EMBEDDING_DIMS=${vec.length} to match your model output.`;
        throw new Error(
          `Embedding dimension mismatch: endpoint returned ${vec.length}d vector, ` +
            `but expected ${expected}d. ${hint}`,
        );
      }
      allVectors[b.offset + j] = vec;
    }
  };

  // Sliding concurrency window — keeps HTTP_CONCURRENCY requests in-flight simultaneously
  // to saturate multi-instance vLLM backends behind nginx LB.
  for (let i = 0; i < batches.length; i += HTTP_CONCURRENCY) {
    await Promise.all(batches.slice(i, i + HTTP_CONCURRENCY).map(processBatch));
  }

  return allVectors;
};

/**
 * Embed a single query text via the HTTP backend.
 * Convenience for MCP search where only one vector is needed.
 *
 * @param text - Query text to embed
 * @returns Embedding vector as number array
 */
export const httpEmbedQuery = async (text: string): Promise<number[]> => {
  const config = readConfig();
  if (!config) throw new Error('HTTP embedding not configured');

  const url = `${config.baseUrl}/embeddings`;
  const items = await httpEmbedBatch(url, [text], config.model, config.apiKey, config.dimensions);
  if (!items.length) {
    throw new Error(`Embedding endpoint returned empty response (${safeUrl(url)})`);
  }

  const embedding = items[0].embedding;
  // Same dimension checks as httpEmbed — catch mismatches before they
  // reach the Kuzu FLOAT[N] cast in search queries.
  const expected = config.dimensions ?? DEFAULT_DIMS;
  if (embedding.length !== expected) {
    const hint = config.dimensions
      ? 'Update GITNEXUS_EMBEDDING_DIMS to match your model output.'
      : `Set GITNEXUS_EMBEDDING_DIMS=${embedding.length} to match your model output.`;
    throw new Error(
      `Embedding dimension mismatch: endpoint returned ${embedding.length}d vector, ` +
        `but expected ${expected}d. ${hint}`,
    );
  }
  return embedding;
};
