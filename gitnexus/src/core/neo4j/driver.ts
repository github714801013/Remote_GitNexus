import neo4j, { type Driver, type Session } from 'neo4j-driver';
import { loadNeo4jConfig, type Neo4jConfig } from './config.js';

let cachedDriver: Driver | null = null;
let cachedKey = '';

const driverKey = (config: Neo4jConfig): string => {
  return [config.uri, config.user, config.database].join('\0');
};

export const getNeo4jDriver = (): Driver => {
  const config = loadNeo4jConfig();
  if (!config.enabled) {
    throw new Error('Neo4j backend is disabled. Set GITNEXUS_STORAGE_BACKEND=neo4j first.');
  }

  const key = driverKey(config);
  if (cachedDriver && cachedKey === key) {
    return cachedDriver;
  }

  cachedDriver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
  cachedKey = key;
  return cachedDriver;
};

export const withNeo4jSession = async <T>(
  work: (session: Session) => Promise<T> | T,
): Promise<T> => {
  const config = loadNeo4jConfig();
  const session = getNeo4jDriver().session({ database: config.database });
  try {
    return await work(session);
  } finally {
    await session.close();
  }
};

export const closeNeo4j = async (): Promise<void> => {
  const driver = cachedDriver;
  cachedDriver = null;
  cachedKey = '';
  if (driver) {
    await driver.close();
  }
};
