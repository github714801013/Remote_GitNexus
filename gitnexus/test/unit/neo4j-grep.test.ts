import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn(),
  executeQuery: vi.fn(async () => {
    throw new Error('LadybugDB not initialized');
  }),
  executeParameterized: vi.fn(async () => {
    throw new Error('LadybugDB not initialized');
  }),
  closeLbug: vi.fn(),
  isLbugReady: vi.fn(() => false),
  isWriteQuery: vi.fn(() => false),
}));

vi.mock('../../src/core/neo4j/config.js', () => ({
  isNeo4jBackendEnabled: vi.fn(() => true),
}));

vi.mock('../../src/core/neo4j/read-adapter.js', () => ({
  executeReadCypher: vi.fn(async () => []),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { executeParameterized, executeQuery } from '../../src/core/lbug/pool-adapter.js';
import { executeReadCypher } from '../../src/core/neo4j/read-adapter.js';

let root: string;
let repo: any;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-neo4j-grep-'));
  const storage = path.join(root, '.gitnexus');
  await fs.mkdir(path.join(storage, 'lbug'), { recursive: true });
  await fs.writeFile(
    path.join(storage, 'gitnexus.json'),
    JSON.stringify({ contentRetention: 'full', indexedAt: '2026-05-30' }),
    'utf-8',
  );
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'auth.ts'), 'signOrder()\nnoop\n', 'utf-8');
  repo = {
    id: 'repo-a',
    name: 'Repo A',
    repoPath: root,
    storagePath: storage,
    lbugPath: path.join(storage, 'lbug'),
    indexedAt: '2026-05-30',
    lastCommit: 'a',
  };
  vi.mocked(executeReadCypher).mockResolvedValue([{ filePath: 'src/auth.ts' }]);
});

afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('MCP grep on the Neo4j backend', () => {
  it('greps indexed files through Neo4j instead of LadybugDB', async () => {
    const backend = new LocalBackend();

    const result = await (backend as any).grep(repo, { pattern: 'signOrder' });

    expect(executeQuery).not.toHaveBeenCalled();
    expect(executeParameterized).not.toHaveBeenCalled();
    expect(result.results).toEqual([
      expect.objectContaining({ filePath: 'src/auth.ts', line: 1, text: 'signOrder()' }),
    ]);
    const [cypher, params] = vi.mocked(executeReadCypher).mock.calls[0] as [string, any];
    expect(cypher).toContain('MATCH (f:File {repoId: $repoId})');
    expect(params.repoId).toBe('Repo A');
  });
});
