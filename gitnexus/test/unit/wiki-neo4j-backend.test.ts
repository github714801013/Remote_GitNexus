import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isNeo4jBackendEnabled: vi.fn(),
  executeReadCypher: vi.fn(),
  initLbug: vi.fn(),
  executeQuery: vi.fn(),
  closeLbug: vi.fn(),
  touchRepo: vi.fn(),
  pinRepo: vi.fn(),
}));

vi.mock('../../src/core/neo4j/config.js', () => ({
  isNeo4jBackendEnabled: mocks.isNeo4jBackendEnabled,
}));

vi.mock('../../src/core/neo4j/read-adapter.js', () => ({
  executeReadCypher: mocks.executeReadCypher,
}));

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: mocks.initLbug,
  executeQuery: mocks.executeQuery,
  closeLbug: mocks.closeLbug,
  touchRepo: mocks.touchRepo,
  pinRepo: mocks.pinRepo,
}));

const int = (n: number) => ({ toNumber: () => n });

describe('wiki graph-queries 双后端分派', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.pinRepo.mockReturnValue(() => {});
  });

  afterEach(() => {
    mocks.isNeo4jBackendEnabled.mockReset();
  });

  describe('本地 LadybugDB 模式（回归不变）', () => {
    it('init/touch/pin/close 序列与既有契约一致', async () => {
      const gq = await import('../../src/core/wiki/graph-queries.js');
      mocks.isNeo4jBackendEnabled.mockReturnValue(false);

      await gq.initWikiDb('repo/.gitnexus/lbug');
      expect(mocks.initLbug).toHaveBeenCalledWith('__wiki__', 'repo/.gitnexus/lbug');
      expect(mocks.executeReadCypher).not.toHaveBeenCalled();

      gq.touchWikiDb();
      expect(mocks.touchRepo).toHaveBeenCalledWith('__wiki__');

      const release = gq.pinWikiDb();
      expect(mocks.pinRepo).toHaveBeenCalledWith('__wiki__');
      release();

      await gq.closeWikiDb();
      expect(mocks.closeLbug).toHaveBeenCalledWith('__wiki__');
    });

    it('查询仍走本地 lbug 池', async () => {
      const gq = await import('../../src/core/wiki/graph-queries.js');
      mocks.isNeo4jBackendEnabled.mockReturnValue(false);
      await gq.initWikiDb('repo/.gitnexus/lbug');

      mocks.executeQuery.mockResolvedValue([{ filePath: 'b.ts' }, { filePath: 'a.ts' }]);
      const files = await gq.getAllFiles();
      expect(files).toEqual(['b.ts', 'a.ts']);
      expect(mocks.executeQuery).toHaveBeenCalledWith('__wiki__', expect.any(String));
      expect(mocks.executeReadCypher).not.toHaveBeenCalled();
    });
  });

  describe('Neo4j 模式', () => {
    it('repoId 缺失时快速失败且不触碰本地 lbug', async () => {
      const gq = await import('../../src/core/wiki/graph-queries.js');
      mocks.isNeo4jBackendEnabled.mockReturnValue(true);

      await expect(gq.initWikiDb('repo/.gitnexus/lbug')).rejects.toThrow(/repoId/i);
      expect(mocks.initLbug).not.toHaveBeenCalled();

      await expect(gq.initWikiDb('repo/.gitnexus/lbug', '')).rejects.toThrow(/repoId/i);
      expect(mocks.initLbug).not.toHaveBeenCalled();

      await gq.initWikiDb('repo/.gitnexus/lbug', 'repo-a');
      expect(mocks.initLbug).not.toHaveBeenCalled();
    });

    it('init 前 touch/pin/close 亦为 no-op（分派基准一致性）', async () => {
      const gq = await import('../../src/core/wiki/graph-queries.js');
      mocks.isNeo4jBackendEnabled.mockReturnValue(true);

      // generator 的序列是 pin → init：Neo4j 模式下 pin 必须在 init 之前
      // 就已是 no-op，不得触碰 lbug 池（规格 §4.4/§7.7）。
      expect(() => gq.touchWikiDb()).not.toThrow();
      expect(mocks.touchRepo).not.toHaveBeenCalled();

      const release = gq.pinWikiDb();
      expect(mocks.pinRepo).not.toHaveBeenCalled();
      expect(() => {
        release();
        release();
      }).not.toThrow();

      await expect(gq.closeWikiDb()).resolves.toBeUndefined();
      expect(mocks.closeLbug).not.toHaveBeenCalled();
    });

    it('getAllFiles 经 executeReadCypher 且携带 repoId，映射保持输入序', async () => {
      const gq = await import('../../src/core/wiki/graph-queries.js');
      mocks.isNeo4jBackendEnabled.mockReturnValue(true);
      await gq.initWikiDb('', 'repo-a');

      mocks.executeReadCypher.mockResolvedValue([{ filePath: 'b.ts' }, { filePath: 'a.ts' }]);
      const files = await gq.getAllFiles();
      expect(files).toEqual(['b.ts', 'a.ts']);
      expect(mocks.executeReadCypher).toHaveBeenCalledTimes(1);
      expect(mocks.executeReadCypher.mock.calls[0][1]).toMatchObject({ repoId: 'repo-a' });
    });

    it('getInterFileCallEdges 经 executeReadCypher 且携带 repoId，CallEdge 形状等价', async () => {
      const gq = await import('../../src/core/wiki/graph-queries.js');
      mocks.isNeo4jBackendEnabled.mockReturnValue(true);
      await gq.initWikiDb('', 'repo-a');

      mocks.executeReadCypher.mockResolvedValue([
        { fromFile: 'a.ts', fromName: 'f', toFile: 'b.ts', toName: 'g' },
      ]);
      const edges = await gq.getInterFileCallEdges();
      expect(edges).toEqual([{ fromFile: 'a.ts', fromName: 'f', toFile: 'b.ts', toName: 'g' }]);
      expect(mocks.executeReadCypher.mock.calls[0][1]).toMatchObject({ repoId: 'repo-a' });
    });

    it('getFilesWithExports 经 executeReadCypher 且携带 repoId，形状等价', async () => {
      const gq = await import('../../src/core/wiki/graph-queries.js');
      mocks.isNeo4jBackendEnabled.mockReturnValue(true);
      await gq.initWikiDb('', 'repo-a');

      mocks.executeReadCypher.mockResolvedValue([
        { filePath: 'a.ts', name: 'alpha', type: 'Function' },
        { filePath: 'a.ts', name: 'Beta', type: 'Class' },
        { filePath: 'b.ts', name: 'gamma', type: 'Function' },
      ]);
      const result = await gq.getFilesWithExports();
      expect(mocks.executeReadCypher).toHaveBeenCalledTimes(1);
      expect(mocks.executeReadCypher.mock.calls[0][1]).toMatchObject({ repoId: 'repo-a' });
      expect(result).toEqual([
        { filePath: 'a.ts', symbols: [{ name: 'alpha', type: 'Function' }, { name: 'Beta', type: 'Class' }] },
        { filePath: 'b.ts', symbols: [{ name: 'gamma', type: 'Function' }] },
      ]);
    });

    it('调用边查询参数化 repoId 与 filePaths，方向语义与 LIMIT 保留', async () => {
      const gq = await import('../../src/core/wiki/graph-queries.js');
      mocks.isNeo4jBackendEnabled.mockReturnValue(true);
      await gq.initWikiDb('', 'repo-a');

      mocks.executeReadCypher
        .mockResolvedValueOnce([{ fromFile: 'a.ts', fromName: 'f', toFile: 'x.ts', toName: 'h' }])
        .mockResolvedValueOnce([{ fromFile: 'y.ts', fromName: 'i', toFile: 'a.ts', toName: 'j' }])
        .mockResolvedValueOnce([{ fromFile: 'a.ts', fromName: 'f', toFile: 'x.ts', toName: 'h' }]);

      const moduleEdges = await gq.getInterModuleCallEdges(['a.ts', 'b.ts']);
      expect(moduleEdges.outgoing).toEqual([{ fromFile: 'a.ts', fromName: 'f', toFile: 'x.ts', toName: 'h' }]);
      expect(moduleEdges.incoming).toEqual([{ fromFile: 'y.ts', fromName: 'i', toFile: 'a.ts', toName: 'j' }]);
      expect(mocks.executeReadCypher).toHaveBeenCalledTimes(2);
      for (const call of mocks.executeReadCypher.mock.calls) {
        expect(call[1]).toMatchObject({ repoId: 'repo-a', filePaths: ['a.ts', 'b.ts'] });
      }

      const intra = await gq.getIntraModuleCallEdges(['a.ts', 'b.ts']);
      expect(intra).toEqual([{ fromFile: 'a.ts', fromName: 'f', toFile: 'x.ts', toName: 'h' }]);
      expect(mocks.executeReadCypher.mock.calls[2][1]).toMatchObject({
        repoId: 'repo-a',
        filePaths: ['a.ts', 'b.ts'],
      });
    });

    it('空输入短路：不发起任何后端调用', async () => {
      const gq = await import('../../src/core/wiki/graph-queries.js');
      mocks.isNeo4jBackendEnabled.mockReturnValue(true);
      await gq.initWikiDb('', 'repo-a');

      expect(await gq.getIntraModuleCallEdges([])).toEqual([]);
      expect(await gq.getInterModuleCallEdges([])).toEqual({ outgoing: [], incoming: [] });
      expect(await gq.getProcessesForFiles([])).toEqual([]);
      expect(mocks.executeReadCypher).not.toHaveBeenCalled();
      expect(mocks.executeQuery).not.toHaveBeenCalled();
    });

    it('进程两步查询：stepCount 归一为 number、步骤按输入序映射、label 取 heuristicLabel', async () => {
      const gq = await import('../../src/core/wiki/graph-queries.js');
      mocks.isNeo4jBackendEnabled.mockReturnValue(true);
      await gq.initWikiDb('', 'repo-a');

      mocks.executeReadCypher
        .mockResolvedValueOnce([{ id: 'p1', label: 'LoginFlow', type: 'workflow', stepCount: int(7) }])
        .mockResolvedValueOnce([
          { name: 'first', filePath: 'a.ts', type: 'Function', step: int(1) },
          { name: 'second', filePath: 'b.ts', type: 'Method', step: int(2) },
        ]);

      const processes = await gq.getProcessesForFiles(['a.ts'], 5);
      expect(processes).toHaveLength(1);
      expect(processes[0]).toMatchObject({
        id: 'p1',
        label: 'LoginFlow',
        type: 'workflow',
        stepCount: 7,
      });
      expect(processes[0].steps).toEqual([
        { step: 1, name: 'first', filePath: 'a.ts', type: 'Function' },
        { step: 2, name: 'second', filePath: 'b.ts', type: 'Method' },
      ]);
      expect(mocks.executeReadCypher.mock.calls[0][1]).toMatchObject({
        repoId: 'repo-a',
        filePaths: ['a.ts'],
        limit: 5,
      });
      expect(mocks.executeReadCypher.mock.calls[1][1]).toMatchObject({ repoId: 'repo-a', procId: 'p1' });
    });

    it('getAllProcesses 两步查询：按输入序映射、stepCount 归一、limit 参数化', async () => {
      const gq = await import('../../src/core/wiki/graph-queries.js');
      mocks.isNeo4jBackendEnabled.mockReturnValue(true);
      await gq.initWikiDb('', 'repo-a');

      mocks.executeReadCypher
        .mockResolvedValueOnce([{ id: 'p2', label: 'BuildFlow', type: 'workflow', stepCount: int(4) }])
        .mockResolvedValueOnce([
          { name: 'one', filePath: 'x.ts', type: 'Function', step: int(1) },
          { name: 'two', filePath: 'y.ts', type: 'Method', step: int(2) },
        ]);

      const processes = await gq.getAllProcesses(20);
      expect(processes).toHaveLength(1);
      expect(processes[0]).toMatchObject({
        id: 'p2',
        label: 'BuildFlow',
        type: 'workflow',
        stepCount: 4,
      });
      expect(processes[0].steps).toEqual([
        { step: 1, name: 'one', filePath: 'x.ts', type: 'Function' },
        { step: 2, name: 'two', filePath: 'y.ts', type: 'Method' },
      ]);
      expect(mocks.executeReadCypher.mock.calls[0][1]).toMatchObject({ repoId: 'repo-a', limit: 20 });
      expect(mocks.executeReadCypher.mock.calls[1][1]).toMatchObject({ repoId: 'repo-a', procId: 'p2' });
    });
  });
});
