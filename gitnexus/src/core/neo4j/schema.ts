import { EMBEDDING_TABLE_NAME, NODE_TABLES } from 'gitnexus-shared';
import { loadNeo4jConfig } from './config.js';

export interface Neo4jSchemaOptions {
  embeddingDims?: number;
}

export interface Neo4jSchemaStatements {
  constraints: string[];
  indexes: string[];
  vectorIndexes: string[];
  all: string[];
}

const SYMBOL_NAME_INDEX_LABELS = [
  'Function',
  'Class',
  'Interface',
  'Method',
  'CodeElement',
  'Route',
  'Tool',
] as const;
const CODE_NODE_LABEL = 'CodeNode';

const constraintForLabel = (label: string): string => {
  return `CREATE CONSTRAINT gitnexus_${label}_repo_id IF NOT EXISTS FOR (n:\`${label}\`) REQUIRE (n.repoId, n.id) IS UNIQUE`;
};

const indexForLabelName = (label: string): string => {
  return `CREATE INDEX gitnexus_${label}_repo_name IF NOT EXISTS FOR (n:\`${label}\`) ON (n.repoId, n.name)`;
};

export const getNeo4jSchemaStatements = (
  options: Neo4jSchemaOptions = {},
): Neo4jSchemaStatements => {
  const embeddingDims = options.embeddingDims ?? loadNeo4jConfig().embeddingDims;
  const constraints = [
    constraintForLabel(CODE_NODE_LABEL),
    ...NODE_TABLES.map(constraintForLabel),
    constraintForLabel(EMBEDDING_TABLE_NAME),
  ];
  const indexes = [
    'CREATE INDEX gitnexus_File_repo_filePath IF NOT EXISTS FOR (n:`File`) ON (n.repoId, n.filePath)',
    ...SYMBOL_NAME_INDEX_LABELS.map(indexForLabelName),
  ];
  const vectorIndexes = [
    `CREATE VECTOR INDEX code_embedding_idx IF NOT EXISTS FOR (n:\`${EMBEDDING_TABLE_NAME}\`) ON (n.embedding) OPTIONS { indexConfig: { \`vector.dimensions\`: ${embeddingDims}, \`vector.similarity_function\`: 'cosine' } }`,
  ];
  return {
    constraints,
    indexes,
    vectorIndexes,
    all: [...constraints, ...indexes, ...vectorIndexes],
  };
};
