import fs from 'fs/promises';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import lbug from '@ladybugdb/core';

export interface LbugProbeResult {
  ok: boolean;
  error?: string;
}

export type LbugProbe = (dbPath: string) => Promise<LbugProbeResult>;

export interface IndexBackupManifest {
  repoPath?: string;
  createdAt: string;
  lbugSize: number;
  metaSize?: number;
  sourceMeta?: any;
}

export interface IndexBackupOptions {
  lbugPath: string;
  metaPath: string;
  repoPath?: string;
  probe?: LbugProbe;
}

export interface IndexBackupResult {
  status: 'created' | 'skipped-missing-live' | 'skipped-invalid-live';
  backupPath?: string;
  reason?: string;
}

export interface EmbeddingShadowPaths {
  shadowLbugPath: string;
  shadowMetaPath: string;
}

const BACKUP_DIR_NAME = 'backups';
const LATEST_BACKUP_NAME = 'latest';
const TMP_BACKUP_NAME = 'latest.tmp';
const OLD_BACKUP_NAME = 'latest.old';

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfExists(source: string, target: string): Promise<boolean> {
  if (!(await exists(source))) return false;
  await fs.copyFile(source, target);
  return true;
}

async function moveIfExists(source: string, target: string): Promise<boolean> {
  if (!(await exists(source))) return false;
  await fs.rename(source, target);
  return true;
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  const retryableCodes = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);
  let lastError: any;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fs.rename(source, target);
      return;
    } catch (err: any) {
      lastError = err;
      if (!retryableCodes.has(err?.code)) throw err;
      await delay(25 * (attempt + 1));
    }
  }
  throw lastError;
}

function storagePathFor(lbugPath: string): string {
  return path.dirname(lbugPath);
}

function latestBackupPath(storagePath: string): string {
  return path.join(storagePath, BACKUP_DIR_NAME, LATEST_BACKUP_NAME);
}

function tmpBackupPath(storagePath: string): string {
  return path.join(storagePath, BACKUP_DIR_NAME, TMP_BACKUP_NAME);
}

function oldBackupPath(storagePath: string): string {
  return path.join(storagePath, BACKUP_DIR_NAME, OLD_BACKUP_NAME);
}

export function isLbugLockError(message: string): boolean {
  return message.includes('Could not set lock') || /\block\b/i.test(message);
}

export function isLbugCorruptionError(message: string): boolean {
  return (
    message.includes('not a valid Lbug database file') ||
    message.includes('Unable to open database') ||
    message.includes('failed integrity check')
  );
}

export async function probeLbugFile(dbPath: string): Promise<LbugProbeResult> {
  let db: lbug.Database | null = null;
  let conn: lbug.Connection | null = null;
  try {
    db = new lbug.Database(dbPath, 0, false, true);
    conn = new lbug.Connection(db);
    const queryResult = await conn.query('RETURN 1');
    const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
    await result.getAll();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    if (conn) {
      try {
        await conn.close();
      } catch {
        /* swallow */
      }
    }
    if (db) {
      try {
        await db.close();
      } catch {
        /* swallow */
      }
    }
  }
}

export async function backupLatestIndex(options: IndexBackupOptions): Promise<IndexBackupResult> {
  const { lbugPath, metaPath, repoPath, probe = probeLbugFile } = options;
  if (!(await exists(lbugPath))) {
    return { status: 'skipped-missing-live', reason: 'live lbug does not exist' };
  }

  const storagePath = storagePathFor(lbugPath);
  const backupsDir = path.join(storagePath, BACKUP_DIR_NAME);
  const tmpDir = tmpBackupPath(storagePath);
  const latestDir = latestBackupPath(storagePath);
  const oldDir = oldBackupPath(storagePath);

  await fs.mkdir(backupsDir, { recursive: true });
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(oldDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });

  const tmpLbugPath = path.join(tmpDir, 'lbug');
  const tmpMetaPath = path.join(tmpDir, 'meta.json');
  await fs.copyFile(lbugPath, tmpLbugPath);
  await copyIfExists(`${lbugPath}.wal`, path.join(tmpDir, 'lbug.wal'));
  await copyIfExists(metaPath, tmpMetaPath);

  const backupProbe = await probe(tmpLbugPath);
  if (!backupProbe.ok) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    return {
      status: 'skipped-invalid-live',
      reason: backupProbe.error ?? 'copied live lbug probe failed',
    };
  }

  const lbugStat = await fs.stat(tmpLbugPath);
  const metaStat = (await exists(tmpMetaPath)) ? await fs.stat(tmpMetaPath) : undefined;
  let sourceMeta: any;
  if (await exists(tmpMetaPath)) {
    try {
      sourceMeta = JSON.parse(await fs.readFile(tmpMetaPath, 'utf-8'));
    } catch {
      sourceMeta = undefined;
    }
  }
  const manifest: IndexBackupManifest = {
    repoPath,
    createdAt: new Date().toISOString(),
    lbugSize: lbugStat.size,
    metaSize: metaStat?.size,
    sourceMeta,
  };
  await fs.writeFile(
    path.join(tmpDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  );

  if (await exists(latestDir)) {
    await renameWithRetry(latestDir, oldDir);
  }
  await renameWithRetry(tmpDir, latestDir);
  await fs.rm(oldDir, { recursive: true, force: true });

  return { status: 'created', backupPath: latestDir };
}

export async function prepareEmbeddingShadowIndex(
  lbugPath: string,
  metaPath: string,
  paths?: Partial<EmbeddingShadowPaths>,
): Promise<EmbeddingShadowPaths> {
  const shadowLbugPath = paths?.shadowLbugPath ?? `${lbugPath}.embedding-shadow`;
  const shadowMetaPath = paths?.shadowMetaPath ?? `${metaPath}.embedding-shadow`;

  for (const filePath of [
    shadowLbugPath,
    `${shadowLbugPath}.wal`,
    `${shadowLbugPath}.lock`,
    shadowMetaPath,
  ]) {
    await fs.rm(filePath, { recursive: true, force: true });
  }

  await fs.copyFile(lbugPath, shadowLbugPath);
  await copyIfExists(`${lbugPath}.wal`, `${shadowLbugPath}.wal`);
  await copyIfExists(metaPath, shadowMetaPath);

  return { shadowLbugPath, shadowMetaPath };
}

export async function swapEmbeddingShadowToLive(
  lbugPath: string,
  metaPath: string,
  paths?: Partial<EmbeddingShadowPaths>,
): Promise<void> {
  const shadowLbugPath = paths?.shadowLbugPath ?? `${lbugPath}.embedding-shadow`;
  const shadowMetaPath = paths?.shadowMetaPath ?? `${metaPath}.embedding-shadow`;

  for (const filePath of [`${lbugPath}.lock`, `${lbugPath}.wal`]) {
    await fs.rm(filePath, { recursive: true, force: true });
  }

  await fs.rename(shadowLbugPath, lbugPath);
  await moveIfExists(`${shadowLbugPath}.wal`, `${lbugPath}.wal`);
  await moveIfExists(shadowMetaPath, metaPath);

  await fs.rm(`${shadowLbugPath}.lock`, { recursive: true, force: true });
}

export async function restoreLatestIndexBackup(
  options: IndexBackupOptions,
): Promise<{ restored: boolean; reason?: string; backupPath?: string }> {
  const { lbugPath, metaPath, probe = probeLbugFile } = options;
  const storagePath = storagePathFor(lbugPath);
  const latestDir = latestBackupPath(storagePath);
  const backupLbugPath = path.join(latestDir, 'lbug');
  const backupMetaPath = path.join(latestDir, 'meta.json');

  if (!(await exists(backupLbugPath))) {
    return { restored: false, reason: 'latest backup does not exist' };
  }

  const backupProbe = await probe(backupLbugPath);
  if (!backupProbe.ok) {
    return {
      restored: false,
      reason: backupProbe.error ?? 'latest backup probe failed',
      backupPath: latestDir,
    };
  }

  const restoreLbugTmp = `${lbugPath}.restore.tmp`;
  const restoreWalTmp = `${lbugPath}.wal.restore.tmp`;
  const restoreMetaTmp = `${metaPath}.restore.tmp`;

  await fs.copyFile(backupLbugPath, restoreLbugTmp);
  const hasWal = await copyIfExists(path.join(latestDir, 'lbug.wal'), restoreWalTmp);
  const hasMeta = await copyIfExists(backupMetaPath, restoreMetaTmp);

  await fs.rm(`${lbugPath}.lock`, { force: true, recursive: true });
  await fs.rm(`${lbugPath}.wal`, { force: true, recursive: true });
  await fs.rename(restoreLbugTmp, lbugPath);
  if (hasWal) {
    await fs.rename(restoreWalTmp, `${lbugPath}.wal`);
  }
  if (hasMeta) {
    await fs.rename(restoreMetaTmp, metaPath);
  }

  return { restored: true, backupPath: latestDir };
}
