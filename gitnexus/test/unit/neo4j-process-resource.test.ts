import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { executeParameterized, executeQuery } from '../../src/core/lbug/pool-adapter.js';
import { executeReadCypher } from '../../src/core/neo4j/read-adapter.js';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn(),
  executeQuery: vi.fn(),
  executeParameterized: vi.fn(),
  closeLbug: vi.fn(),
  isLbugReady: vi.fn(() => true),
  statDbIdentity: vi.fn(),
  dbIdentityChanged: vi.fn(),
}));

vi.mock('../../src/core/neo4j/config.js', () => ({
  isNeo4jBackendEnabled: vi.fn(() => true),
}));

vi.mock('../../src/core/neo4j/read-adapter.js', () => ({
  executeReadCypher: vi.fn(),
}));

const repo = {
  id: 'repo-a',
  name: 'Repo A',
  repoPath: '/repo/a',
  storagePath: '/repo/a/.gitnexus',
  lbugPath: '/repo/a/.gitnexus/lbug',
  indexedAt: '2026-05-30',
  lastCommit: 'a',
};

describe('Neo4j process resources', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(executeReadCypher).mockReset();
  });

  it('returns process summaries from Neo4j without using LadybugDB', async () => {
    vi.mocked(executeReadCypher).mockResolvedValueOnce([
      {
        id: 'process-1',
        label: 'RequestFlow',
        heuristicLabel: 'RequestFlow',
        processType: 'entry-point',
        stepCount: 3,
      },
    ]);
    const backend = new LocalBackend();
    (backend as any).repos.set(repo.id, repo);

    const result = await backend.queryProcesses('Repo A', 2);

    expect(result.processes).toEqual([
      {
        id: 'process-1',
        label: 'RequestFlow',
        heuristicLabel: 'RequestFlow',
        processType: 'entry-point',
        stepCount: 3,
      },
    ]);
    expect(executeReadCypher).toHaveBeenCalledWith(
      expect.stringContaining('MATCH (p:Process {repoId: $repoId})'),
      expect.objectContaining({ repoId: 'Repo A' }),
    );
    expect(executeQuery).not.toHaveBeenCalled();
    expect(executeParameterized).not.toHaveBeenCalled();
  });

  it('returns process detail and steps from Neo4j without using LadybugDB', async () => {
    vi.mocked(executeReadCypher)
      .mockResolvedValueOnce([
        {
          id: 'process-1',
          label: 'RequestFlow',
          heuristicLabel: 'RequestFlow',
          processType: 'entry-point',
          stepCount: 2,
        },
      ])
      .mockResolvedValueOnce([
        { name: 'readRequest', type: 'Function', filePath: 'src/request.ts', step: 1 },
        { name: 'writeResponse', type: 'Function', filePath: 'src/response.ts', step: 2 },
      ]);
    const backend = new LocalBackend();
    (backend as any).repos.set(repo.id, repo);

    const result = await backend.queryProcessDetail('RequestFlow', 'Repo A');

    expect(result).toEqual({
      process: {
        id: 'process-1',
        label: 'RequestFlow',
        heuristicLabel: 'RequestFlow',
        processType: 'entry-point',
        stepCount: 2,
      },
      steps: [
        { step: 1, name: 'readRequest', type: 'Function', filePath: 'src/request.ts' },
        { step: 2, name: 'writeResponse', type: 'Function', filePath: 'src/response.ts' },
      ],
    });
    expect(executeReadCypher).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('MATCH (p:Process {repoId: $repoId})'),
      expect.objectContaining({ repoId: 'Repo A', processName: 'RequestFlow' }),
    );
    expect(executeReadCypher).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('STEP_IN_PROCESS'),
      expect.objectContaining({ repoId: 'Repo A', procId: 'process-1' }),
    );
    expect(executeParameterized).not.toHaveBeenCalled();
  });});
