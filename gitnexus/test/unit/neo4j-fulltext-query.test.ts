import { describe, expect, it } from 'vitest';
import { escapeNeo4jFulltextQuery } from '../../src/core/neo4j/fulltext-query.js';

describe('escapeNeo4jFulltextQuery', () => {
  it('keeps plain keyword queries unchanged', () => {
    expect(escapeNeo4jFulltextQuery('handler membership search')).toBe('handler membership search');
  });

  it('escapes quotes and slashes before passing text to Lucene fulltext query', () => {
    expect(
      escapeNeo4jFulltextQuery('"/searchUser route handler membership code user search"'),
    ).toBe('\\"\\/searchUser route handler membership code user search\\"');
  });

  it('escapes other Lucene query operators without dropping words', () => {
    expect(escapeNeo4jFulltextQuery('user:(search+admin) && path\\to/file')).toBe(
      'user\\:\\(search\\+admin\\) \\&\\& path\\\\to\\/file',
    );
  });
});
