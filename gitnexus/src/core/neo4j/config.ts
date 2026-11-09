export interface Neo4jConfig {
  enabled: boolean;
  uri: string;
  user: string;
  password: string;
  database: string;
  embeddingDims: number;
}

const DEFAULT_URI = 'bolt://localhost:7687';
const DEFAULT_USER = 'neo4j';
const DEFAULT_PASSWORD = 'gitnexus';
const DEFAULT_DATABASE = 'neo4j';
const DEFAULT_EMBEDDING_DIMS = 512;

const NEO4J_URI_RE = /^(bolt|neo4j)(\+s)?:\/\//;

export const isNeo4jBackendEnabled = (): boolean => {
  return (process.env.GITNEXUS_STORAGE_BACKEND ?? '').trim().toLowerCase() === 'neo4j';
};

const readEmbeddingDims = (): number => {
  const raw = process.env.GITNEXUS_EMBEDDING_DIMS ?? String(DEFAULT_EMBEDDING_DIMS);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`GITNEXUS_EMBEDDING_DIMS must be a positive integer, got "${raw}"`);
  }
  return parsed;
};

export const loadNeo4jConfig = (): Neo4jConfig => {
  const enabled = isNeo4jBackendEnabled();
  const uri = (process.env.GITNEXUS_NEO4J_URI ?? DEFAULT_URI).trim();
  const user = (process.env.GITNEXUS_NEO4J_USER ?? DEFAULT_USER).trim();
  const password = process.env.GITNEXUS_NEO4J_PASSWORD ?? DEFAULT_PASSWORD;
  const database = (process.env.GITNEXUS_NEO4J_DATABASE ?? DEFAULT_DATABASE).trim();

  if (!NEO4J_URI_RE.test(uri)) {
    throw new Error(
      'GITNEXUS_NEO4J_URI must start with bolt://, neo4j://, bolt+s://, or neo4j+s://',
    );
  }

  if (enabled && password.length === 0) {
    throw new Error('GITNEXUS_NEO4J_PASSWORD is required when GITNEXUS_STORAGE_BACKEND=neo4j');
  }

  if (enabled && user.length === 0) {
    throw new Error('GITNEXUS_NEO4J_USER is required when GITNEXUS_STORAGE_BACKEND=neo4j');
  }

  if (enabled && database.length === 0) {
    throw new Error('GITNEXUS_NEO4J_DATABASE is required when GITNEXUS_STORAGE_BACKEND=neo4j');
  }

  return {
    enabled,
    uri,
    user,
    password,
    database,
    embeddingDims: readEmbeddingDims(),
  };
};
