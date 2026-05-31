import { describe, it, expect } from 'vitest';

describe('run-analyze module', () => {
  it('exports runFullAnalysis as a function', async () => {
    const mod = await import('../../src/core/run-analyze.js');
    expect(typeof mod.runFullAnalysis).toBe('function');
  });

  it('exports runEmbeddingsOnly as a function', async () => {
    const mod = await import('../../src/core/run-analyze.js');
    expect(typeof mod.runEmbeddingsOnly).toBe('function');
  });

  it('exports PHASE_LABELS', async () => {
    const mod = await import('../../src/core/run-analyze.js');
    expect(mod.PHASE_LABELS).toBeDefined();
    expect(mod.PHASE_LABELS.parsing).toBe('Parsing code');
  });

  it('does not skip embedding phase when current index has no embeddings', async () => {
    const mod = await import('../../src/core/run-analyze.js');

    expect(
      mod.shouldReturnAlreadyUpToDate(
        { lastCommit: 'abc123', stats: { embeddings: 0 } },
        'abc123',
        { embeddings: true },
      ),
    ).toBe(false);
  });

  it('skips current index when embeddings are already present', async () => {
    const mod = await import('../../src/core/run-analyze.js');

    expect(
      mod.shouldReturnAlreadyUpToDate(
        { lastCommit: 'abc123', stats: { embeddings: 42 } },
        'abc123',
        { embeddings: true },
      ),
    ).toBe(true);
  });

  it('does not skip current index when registry branch changed', async () => {
    const mod = await import('../../src/core/run-analyze.js');

    expect(
      mod.shouldReturnAlreadyUpToDate(
        { lastCommit: 'abc123', branch: 'dev', stats: { embeddings: 42 } },
        'abc123',
        { embeddings: true, registryBranch: 'release_9ji' },
      ),
    ).toBe(false);
  });

  it('skips current index when registry branch still matches', async () => {
    const mod = await import('../../src/core/run-analyze.js');

    expect(
      mod.shouldReturnAlreadyUpToDate(
        { lastCommit: 'abc123', branch: 'release_9ji', stats: { embeddings: 42 } },
        'abc123',
        { embeddings: true, registryBranch: 'release_9ji' },
      ),
    ).toBe(true);
  });

  it('inherits embedding generation when the existing index has embeddings', async () => {
    const mod = await import('../../src/core/run-analyze.js');

    expect(
      mod.shouldGenerateEmbeddingsForAnalysis(
        { stats: { embeddings: 42 } },
        { embeddings: undefined },
      ),
    ).toBe(true);
  });

  it('does not generate embeddings by default for indexes without embeddings', async () => {
    const mod = await import('../../src/core/run-analyze.js');

    expect(
      mod.shouldGenerateEmbeddingsForAnalysis(
        { stats: { embeddings: 0 } },
        { embeddings: undefined },
      ),
    ).toBe(false);
  });

  it('respects an explicit request to skip embeddings', async () => {
    const mod = await import('../../src/core/run-analyze.js');

    expect(
      mod.shouldGenerateEmbeddingsForAnalysis({ stats: { embeddings: 42 } }, { embeddings: false }),
    ).toBe(false);
  });
});
