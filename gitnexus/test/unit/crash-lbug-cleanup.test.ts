import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// 被测函数：worker crash 后清理损坏 lbug
import { cleanCorruptedLbugAfterCrash } from '../../src/server/crash-lbug-cleanup.js';

describe('cleanCorruptedLbugAfterCrash', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-crash-test-'));
  });

  it('删除损坏的 lbug 和 lbug.wal，返回 cleaned=true', async () => {
    const lbugPath = path.join(tmpDir, 'lbug');
    const walPath = path.join(tmpDir, 'lbug.wal');
    await fs.writeFile(lbugPath, 'corrupted');
    await fs.writeFile(walPath, 'wal');

    // probe 返回损坏
    const probe = vi.fn().mockResolvedValue({ ok: false, error: 'not a valid Lbug database file' });
    const result = await cleanCorruptedLbugAfterCrash(tmpDir, probe);

    expect(result.cleaned).toBe(true);
    expect(result.reason).toMatch(/corrupt/i);
    await expect(fs.access(lbugPath)).rejects.toThrow();
    await expect(fs.access(walPath)).rejects.toThrow();
  });

  it('lbug 不存在时跳过清理，返回 cleaned=false', async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true });
    const result = await cleanCorruptedLbugAfterCrash(tmpDir, probe);

    expect(result.cleaned).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('lbug 健康时不删除，返回 cleaned=false', async () => {
    const lbugPath = path.join(tmpDir, 'lbug');
    await fs.writeFile(lbugPath, 'valid-db-content');

    const probe = vi.fn().mockResolvedValue({ ok: true });
    const result = await cleanCorruptedLbugAfterCrash(tmpDir, probe);

    expect(result.cleaned).toBe(false);
    // 文件仍然存在
    await expect(fs.access(lbugPath)).resolves.toBeUndefined();
  });

  it('probe 抛出异常时视为损坏，执行清理', async () => {
    const lbugPath = path.join(tmpDir, 'lbug');
    await fs.writeFile(lbugPath, 'corrupted');

    const probe = vi.fn().mockRejectedValue(new Error('SIGSEGV'));
    const result = await cleanCorruptedLbugAfterCrash(tmpDir, probe);

    expect(result.cleaned).toBe(true);
    await expect(fs.access(lbugPath)).rejects.toThrow();
  });

  it('只删除 lbug 和 lbug.wal，不删除其他文件', async () => {
    const lbugPath = path.join(tmpDir, 'lbug');
    const walPath = path.join(tmpDir, 'lbug.wal');
    const metaPath = path.join(tmpDir, 'meta.json');
    await fs.writeFile(lbugPath, 'corrupted');
    await fs.writeFile(walPath, 'wal');
    await fs.writeFile(metaPath, '{}');

    const probe = vi.fn().mockResolvedValue({ ok: false, error: 'corrupt' });
    await cleanCorruptedLbugAfterCrash(tmpDir, probe);

    // meta.json 保留
    await expect(fs.access(metaPath)).resolves.toBeUndefined();
  });
});
