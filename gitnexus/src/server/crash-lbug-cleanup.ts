import fs from 'fs/promises';
import path from 'path';
import type { LbugProbe } from '../core/lbug/index-backup.js';
import { probeLbugFile } from '../core/lbug/index-backup.js';

export interface CrashCleanupResult {
  cleaned: boolean;
  reason?: string;
}

/**
 * Worker crash 后检查 lbug 健康状态，若损坏则清理 lbug 和 lbug.wal。
 * storagePath 是 <repoPath>/.gitnexus 目录。
 */
export async function cleanCorruptedLbugAfterCrash(
  storagePath: string,
  probe: LbugProbe = probeLbugFile,
): Promise<CrashCleanupResult> {
  const lbugPath = path.join(storagePath, 'lbug');
  const walPath = path.join(storagePath, 'lbug.wal');

  // lbug 不存在则无需清理
  try {
    await fs.access(lbugPath);
  } catch {
    return { cleaned: false };
  }

  // 探测健康状态
  let isCorrupted = false;
  let reason = '';
  try {
    const result = await probe(lbugPath);
    if (!result.ok) {
      isCorrupted = true;
      reason = result.error ?? 'probe returned not ok';
    }
  } catch (err: any) {
    isCorrupted = true;
    reason = String(err?.message ?? err);
  }

  if (!isCorrupted) {
    return { cleaned: false };
  }

  // 清理损坏文件
  for (const f of [lbugPath, walPath]) {
    try {
      await fs.rm(f, { force: true, recursive: true });
    } catch {
      // 忽略不存在的文件
    }
  }

  return { cleaned: true, reason: `corrupt lbug removed: ${reason}` };
}
