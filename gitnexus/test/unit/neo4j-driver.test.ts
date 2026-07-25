import { afterEach, describe, expect, it, vi } from 'vitest';

const mockClose = vi.fn();
const mockSessionClose = vi.fn();
const mockSession = { close: mockSessionClose };
const mockDriver = {
  session: vi.fn(() => mockSession),
  close: mockClose,
};

const mockNeo4jDriver = vi.fn(() => mockDriver);
const mockBasic = vi.fn((user: string, password: string) => ({ user, password }));

vi.mock('neo4j-driver', () => ({
  default: {
    auth: {
      basic: mockBasic,
    },
    driver: mockNeo4jDriver,
  },
}));

const ENV_KEYS = [
  'GITNEXUS_STORAGE_BACKEND',
  'GITNEXUS_NEO4J_URI',
  'GITNEXUS_NEO4J_USER',
  'GITNEXUS_NEO4J_PASSWORD',
  'GITNEXUS_NEO4J_DATABASE',
] as const;

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const enableNeo4j = () => {
  process.env.GITNEXUS_STORAGE_BACKEND = 'neo4j';
  process.env.GITNEXUS_NEO4J_URI = 'bolt://neo4j:7687';
  process.env.GITNEXUS_NEO4J_USER = 'gitnexus';
  process.env.GITNEXUS_NEO4J_PASSWORD = 'secret';
  process.env.GITNEXUS_NEO4J_DATABASE = 'gitnexus';
};

describe('Neo4j driver lifecycle', () => {
  afterEach(async () => {
    try {
      const mod = await import('../../src/core/neo4j/driver.js');
      await mod.closeNeo4j();
    } catch {}

    vi.resetModules();
    vi.clearAllMocks();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('creates one driver for the active Neo4j config', async () => {
    enableNeo4j();
    const { getNeo4jDriver } = await import('../../src/core/neo4j/driver.js');

    expect(getNeo4jDriver()).toBe(mockDriver);
    expect(getNeo4jDriver()).toBe(mockDriver);
    expect(mockBasic).toHaveBeenCalledWith('gitnexus', 'secret');
    expect(mockNeo4jDriver).toHaveBeenCalledTimes(1);
    expect(mockNeo4jDriver).toHaveBeenCalledWith('bolt://neo4j:7687', {
      user: 'gitnexus',
      password: 'secret',
    });
  });

  it('rejects driver access when Neo4j backend is disabled', async () => {
    const { getNeo4jDriver } = await import('../../src/core/neo4j/driver.js');

    expect(() => getNeo4jDriver()).toThrow(
      'Neo4j backend is disabled. Set GITNEXUS_STORAGE_BACKEND=neo4j first.',
    );
    expect(mockNeo4jDriver).not.toHaveBeenCalled();
  });

  it('opens sessions with the configured database and closes them', async () => {
    enableNeo4j();
    const { withNeo4jSession } = await import('../../src/core/neo4j/driver.js');

    const result = await withNeo4jSession(async (session) => {
      expect(session).toBe(mockSession);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(mockDriver.session).toHaveBeenCalledWith({ database: 'gitnexus' });
    expect(mockSessionClose).toHaveBeenCalledTimes(1);
  });

  it('closes sessions even when work throws', async () => {
    enableNeo4j();
    const { withNeo4jSession } = await import('../../src/core/neo4j/driver.js');

    await expect(
      withNeo4jSession(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(mockSessionClose).toHaveBeenCalledTimes(1);
  });

  it('closeNeo4j is idempotent', async () => {
    enableNeo4j();
    const { getNeo4jDriver, closeNeo4j } = await import('../../src/core/neo4j/driver.js');

    getNeo4jDriver();
    await closeNeo4j();
    await closeNeo4j();

    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});
