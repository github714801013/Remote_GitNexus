const NEO4J_FULLTEXT_QUERY_ESCAPE_RE = /([+\-&|!(){}\[\]^"~*?:\\/])/g;

export const escapeNeo4jFulltextQuery = (query: string): string =>
  query.trim().replace(NEO4J_FULLTEXT_QUERY_ESCAPE_RE, '\\$1');
