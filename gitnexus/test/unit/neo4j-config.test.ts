import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'GITNEXUS_STORAGE_BACKEND',
  'GITNEXUS_NEO4J_URI',
  'GITNEXUS_NEO4J_USER',
  'GITNEXUS_NEO4J_PASSWORD',
  'GITNEXUS_NEO4J_DATABASE',
  'GITNEXUS_EMBEDDING_DIMS',
] as const;

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

describe('Neo4j config', () => {
  afterEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('is disabled by default', async () => {
    const { loadNeo4jConfig } = await import('../../src/core/neo4j/config.js');

    expect(loadNeo4jConfig()).toEqual({
      enabled: false,
      uri: 'bolt://localhost:7687',
      user: 'neo4j',
      password: 'gitnexus',
      database: 'neo4j',
      embeddingDims: 512,
    });
  });

  it('reads explicit Neo4j environment variables', async () => {
    process.env.GITNEXUS_STORAGE_BACKEND = 'neo4j';
    process.env.GITNEXUS_NEO4J_URI = 'neo4j://neo4j:7687';
    process.env.GITNEXUS_NEO4J_USER = 'gitnexus';
    process.env.GITNEXUS_NEO4J_PASSWORD = 'secret';
    process.env.GITNEXUS_NEO4J_DATABASE = 'gitnexus';
    process.env.GITNEXUS_EMBEDDING_DIMS = '1536';

    const { loadNeo4jConfig } = await import('../../src/core/neo4j/config.js');

    expect(loadNeo4jConfig()).toEqual({
      enabled: true,
      uri: 'neo4j://neo4j:7687',
      user: 'gitnexus',
      password: 'secret',
      database: 'gitnexus',
      embeddingDims: 1536,
    });
  });

  it('rejects unsupported Neo4j URI schemes', async () => {
    process.env.GITNEXUS_STORAGE_BACKEND = 'neo4j';
    process.env.GITNEXUS_NEO4J_URI = 'http://neo4j:7474';

    const { loadNeo4jConfig } = await import('../../src/core/neo4j/config.js');

    expect(() => loadNeo4jConfig()).toThrow(
      'GITNEXUS_NEO4J_URI must start with bolt://, neo4j://, bolt+s://, or neo4j+s://',
    );
  });

  it('requires a password when Neo4j backend is enabled', async () => {
    process.env.GITNEXUS_STORAGE_BACKEND = 'neo4j';
    process.env.GITNEXUS_NEO4J_PASSWORD = '';

    const { loadNeo4jConfig } = await import('../../src/core/neo4j/config.js');

    expect(() => loadNeo4jConfig()).toThrow(
      'GITNEXUS_NEO4J_PASSWORD is required when GITNEXUS_STORAGE_BACKEND=neo4j',
    );
  });

  it('rejects invalid embedding dimensions', async () => {
    process.env.GITNEXUS_STORAGE_BACKEND = 'neo4j';
    process.env.GITNEXUS_EMBEDDING_DIMS = '0';

    const { loadNeo4jConfig } = await import('../../src/core/neo4j/config.js');

    expect(() => loadNeo4jConfig()).toThrow('GITNEXUS_EMBEDDING_DIMS must be a positive integer');
  });
});
