/**
 * Git Clone Utility
 *
 * Clones repositories into ~/.gitnexus/repos/{name}/.
 * If already cloned, does git pull instead.
 */

import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { isIP } from 'net';

/** Extract the repository name from a git URL (HTTPS or SSH). */
export function extractRepoName(url: string): string {
  const cleaned = url.replace(/\/+$/, '');
  const lastSegment = cleaned.split(/[/:]/).pop() || 'unknown';
  return lastSegment.replace(/\.git$/, '');
}

/** Get the clone target directory for a repo name. */
export function getCloneDir(repoName: string): string {
  return path.join(os.homedir(), '.gitnexus', 'repos', repoName);
}

// Cloud metadata hostnames that must never be reachable via user-supplied URLs
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.azure.com',
  'metadata.internal',
]);

/**
 * Validate a git URL to prevent SSRF attacks.
 * Only allows https:// and http:// schemes. Blocks private/internal addresses,
 * IPv6 private ranges, cloud metadata hostnames, and numeric IP encodings.
 */
export function validateGitUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('Only https:// and http:// git URLs are allowed');
  }

  const host = parsed.hostname.toLowerCase();

  // Block known dangerous hostnames (cloud metadata services)
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // Strip IPv6 brackets if present (URL parser behavior varies across Node versions)
  let normalizedHost = host;
  if (host.startsWith('[') && host.endsWith(']')) {
    normalizedHost = host.slice(1, -1);
  }

  // Check if this is an IPv6 address
  // Use manual colon detection as fallback since isIP may return 0 for some
  // normalized IPv6 forms (e.g. ::ffff:7f00:1)
  const isIPv6 = isIP(normalizedHost) === 6 || normalizedHost.includes(':');
  if (isIPv6) {
    assertNotPrivateIPv6(normalizedHost);
    return;
  }

  // Check if this is an IPv4 address (including numeric encodings)
  if (isIP(normalizedHost) === 4) {
    assertNotPrivateIPv4(normalizedHost);
    return;
  }

  // For non-IP hostnames, check for numeric IP tricks
  // Decimal encoding: 2130706433 = 127.0.0.1
  // Hex encoding: 0x7f000001 = 127.0.0.1
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // Standard IPv4 regex checks for dotted notation
  if (
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\./.test(host) ||
    host === '0.0.0.0' ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^198\.1[89]\./.test(host)
  ) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }
}

function assertNotPrivateIPv6(ip: string): void {
  // Expand common compressed forms for comparison
  const lower = ip.toLowerCase();

  // IPv6 loopback
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // Unspecified address
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // IPv6 Unique Local Address (fc00::/7 = fc and fd prefixes)
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // IPv6 link-local (fe80::/10)
  if (
    lower.startsWith('fe80') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  ) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // IPv4-mapped IPv6 (::ffff:x.x.x.x or ::ffff:hex:hex)
  // Node may normalize ::ffff:127.0.0.1 to ::ffff:7f00:1
  if (lower.startsWith('::ffff:')) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // Also catch the expanded form: 0:0:0:0:0:ffff:
  if (lower.includes(':ffff:')) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }
}

function assertNotPrivateIPv4(ip: string): void {
  const parts = ip.split('.').map(Number);
  const [a, b] = parts;
  if (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  ) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }
}

export interface CloneProgress {
  phase: 'cloning' | 'pulling';
  message: string;
}

class GitCommandError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

export function isGitObjectDatabaseCorruption(err: unknown): boolean {
  const text =
    err instanceof GitCommandError ? err.stderr : err instanceof Error ? err.message : String(err);
  return /object file .* is empty/i.test(text) ||
    /cannot read existing object info/i.test(text) ||
    /invalid index-pack output/i.test(text) ||
    /loose object .* is corrupt/i.test(text) ||
    /fatal: bad object/i.test(text)
    ? true
    : false;
}

/**
 * Clone or pull a git repository.
 * If targetDir doesn't exist: git clone
 * If targetDir exists with .git: git pull --ff-only
 */
export async function cloneOrPull(
  url: string,
  targetDir: string,
  onProgress?: (progress: CloneProgress) => void,
): Promise<string> {
  const exists = await fs.access(path.join(targetDir, '.git')).then(
    () => true,
    () => false,
  );

  if (exists) {
    onProgress?.({ phase: 'pulling', message: 'Pulling latest changes...' });
    await ensureFullHistory(targetDir);
    await runGit(['pull', '--ff-only'], targetDir);
  } else {
    validateGitUrl(url);
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    onProgress?.({ phase: 'cloning', message: `Cloning ${url}...` });
    await runGit(['clone', url, targetDir]);
  }

  return targetDir;
}

/**
 * Synchronize a webhook-managed mirror to a remote branch.
 *
 * This is intentionally stronger than cloneOrPull(): webhook mirrors are cache/index
 * inputs, so local divergent commits should not block startup indexing.
 */
export async function cloneOrResetToBranch(
  url: string,
  targetDir: string,
  branch: string,
  onProgress?: (progress: CloneProgress) => void,
): Promise<string> {
  assertSafeGitRef(branch, 'branch');
  validateGitUrl(url);
  const authenticatedUrl = getAuthenticatedGitUrl(url);
  const exists = await fs.access(path.join(targetDir, '.git')).then(
    () => true,
    () => false,
  );

  if (exists) {
    onProgress?.({ phase: 'pulling', message: `Synchronizing ${branch}...` });
    await fs.rm(path.join(targetDir, '.git', 'index.lock'), { force: true });
    try {
      await ensureFullHistory(targetDir);
      for (const args of buildWebhookBranchSyncCommands(authenticatedUrl, branch)) {
        await runGit(args, targetDir);
      }
    } catch (err) {
      if (!isGitObjectDatabaseCorruption(err)) throw err;
      console.warn(
        `[git] detected corrupt object database; deleting and re-cloning webhook mirror targetDir=${targetDir}`,
      );
      await rebuildCorruptWebhookMirror(authenticatedUrl, targetDir, branch, onProgress);
    }
  } else {
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    onProgress?.({ phase: 'cloning', message: `Cloning ${url}...` });
    await runGit(['clone', '--branch', branch, authenticatedUrl, targetDir]);
  }

  return targetDir;
}

async function rebuildCorruptWebhookMirror(
  url: string,
  targetDir: string,
  branch: string,
  onProgress?: (progress: CloneProgress) => void,
): Promise<void> {
  const metadataDir = await preserveGitNexusMetadata(targetDir);
  try {
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    onProgress?.({ phase: 'cloning', message: `Re-cloning ${branch} after git corruption...` });
    await runGit(['clone', '--branch', branch, url, targetDir]);
    if (metadataDir) {
      await fs.cp(metadataDir, path.join(targetDir, '.gitnexus'), { recursive: true, force: true });
    }
  } finally {
    if (metadataDir) await fs.rm(metadataDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function preserveGitNexusMetadata(targetDir: string): Promise<string | undefined> {
  const source = path.join(targetDir, '.gitnexus');
  const exists = await fs.access(source).then(
    () => true,
    () => false,
  );
  if (!exists) return undefined;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-meta-'));
  const dest = path.join(tempDir, '.gitnexus');
  await fs.cp(source, dest, { recursive: true, force: true });
  return dest;
}

export function buildWebhookBranchSyncCommands(url: string, branch: string): string[][] {
  assertSafeGitRef(branch, 'branch');
  const remoteRef = `refs/remotes/origin/${branch}`;
  return [
    ['remote', 'set-url', 'origin', url],
    ['fetch', 'origin', `+refs/heads/${branch}:${remoteRef}`],
    ['reset', '--hard', remoteRef],
    ['clean', '-fd', '-e', '.gitnexus', '-e', '.gitnexus/'],
    ['checkout', '-B', branch, remoteRef],
    ['reset', '--hard', remoteRef],
    ['clean', '-fd', '-e', '.gitnexus', '-e', '.gitnexus/'],
  ];
}

async function ensureFullHistory(targetDir: string): Promise<void> {
  const shallow = (await runGitOutput(['rev-parse', '--is-shallow-repository'], targetDir)).trim();
  if (shallow === 'true') {
    await runGit(['fetch', '--unshallow', 'origin'], targetDir);
  }
}

export function getAuthenticatedGitUrl(url: string): string {
  const token = process.env.GITEA_TOKEN;
  if (!token || !url.startsWith('http')) return url;
  const parsed = new URL(url);
  parsed.username = token;
  parsed.password = '';
  return parsed.toString();
}

function assertSafeGitRef(value: string, fieldName: string): void {
  if (
    !value ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('..') ||
    /[\s\\~^:?*[\]\x00-\x1F\x7F]/.test(value)
  ) {
    throw new Error(`Invalid ${fieldName}`);
  }
}

function runGit(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Prevent git from prompting for credentials (hangs the process)
        GIT_TERMINAL_PROMPT: '0',
        // Ensure no credential helper tries to open a GUI prompt
        GIT_ASKPASS: process.platform === 'win32' ? 'echo' : '/bin/true',
      },
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else {
        // Log full stderr internally but don't expose it to API callers (SSRF mitigation)
        if (stderr.trim()) console.error(`git ${args[0]} stderr: ${sanitizeGitStderr(stderr)}`);
        reject(new Error(`git ${args[0]} failed (exit code ${code})`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn git: ${err.message}`));
    });
  });
}

function runGitOutput(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: process.platform === 'win32' ? 'echo' : '/bin/true',
      },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });

    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else {
        if (stderr.trim()) console.error(`git ${args[0]} stderr: ${sanitizeGitStderr(stderr)}`);
        reject(new Error(`git ${args[0]} failed (exit code ${code})`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn git: ${err.message}`));
    });
  });
}

function sanitizeGitStderr(stderr: string): string {
  const token = process.env.GITEA_TOKEN;
  return token ? stderr.trim().replaceAll(token, '****') : stderr.trim();
}
