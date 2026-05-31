import { describe, expect, it } from 'vitest';
import { NODE_TABLES, EMBEDDING_TABLE_NAME } from 'gitnexus-shared';

describe('Neo4j schema statements', () => {
  it('creates a shared CodeNode constraint for label-free relationship endpoint lookup', async () => {
    const { getNeo4jSchemaStatements } = await import('../../src/core/neo4j/schema.js');

    const statements = getNeo4jSchemaStatements({ embeddingDims: 1536 });

    expect(statements.constraints).toContain(
      'CREATE CONSTRAINT gitnexus_CodeNode_repo_id IF NOT EXISTS FOR (n:`CodeNode`) REQUIRE (n.repoId, n.id) IS UNIQUE',
    );
  });

  it('creates a repo-scoped uniqueness constraint for every code node label', async () => {
    const { getNeo4jSchemaStatements } = await import('../../src/core/neo4j/schema.js');

    const statements = getNeo4jSchemaStatements({ embeddingDims: 1536 });

    for (const label of NODE_TABLES) {
      expect(statements.constraints).toContain(
        `CREATE CONSTRAINT gitnexus_${label}_repo_id IF NOT EXISTS FOR (n:\`${label}\`) REQUIRE (n.repoId, n.id) IS UNIQUE`,
      );
    }
  });

  it('creates file and symbol lookup indexes used by query tools', async () => {
    const { getNeo4jSchemaStatements } = await import('../../src/core/neo4j/schema.js');

    const statements = getNeo4jSchemaStatements({ embeddingDims: 512 });

    expect(statements.indexes).toContain(
      'CREATE INDEX gitnexus_File_repo_filePath IF NOT EXISTS FOR (n:`File`) ON (n.repoId, n.filePath)',
    );
    expect(statements.indexes).toContain(
      'CREATE INDEX gitnexus_Function_repo_name IF NOT EXISTS FOR (n:`Function`) ON (n.repoId, n.name)',
    );
    expect(statements.indexes).toContain(
      'CREATE INDEX gitnexus_Method_repo_name IF NOT EXISTS FOR (n:`Method`) ON (n.repoId, n.name)',
    );
  });

  it('creates the CodeEmbedding constraint and vector index', async () => {
    const { getNeo4jSchemaStatements } = await import('../../src/core/neo4j/schema.js');

    const statements = getNeo4jSchemaStatements({ embeddingDims: 1536 });

    expect(statements.constraints).toContain(
      `CREATE CONSTRAINT gitnexus_${EMBEDDING_TABLE_NAME}_repo_id IF NOT EXISTS FOR (n:\`${EMBEDDING_TABLE_NAME}\`) REQUIRE (n.repoId, n.id) IS UNIQUE`,
    );
    expect(statements.vectorIndexes).toContain(
      "CREATE VECTOR INDEX code_embedding_idx IF NOT EXISTS FOR (n:`CodeEmbedding`) ON (n.embedding) OPTIONS { indexConfig: { `vector.dimensions`: 1536, `vector.similarity_function`: 'cosine' } }",
    );
  });

  it('returns all statements in execution order', async () => {
    const { getNeo4jSchemaStatements } = await import('../../src/core/neo4j/schema.js');

    const statements = getNeo4jSchemaStatements({ embeddingDims: 512 });

    expect(statements.all).toEqual([
      ...statements.constraints,
      ...statements.indexes,
      ...statements.vectorIndexes,
    ]);
  });
});
