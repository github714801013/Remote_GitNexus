import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildCocoaPodsEnv,
  ensureCocoaPodsDependencies,
  formatPodInstallFailure,
  hasPodfile,
} from '../../src/server/cocoapods.js';

const tempRepo = async () => fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-cocoapods-'));

describe('CocoaPods dependency preparation', () => {
  it('skips repositories without a Podfile', async () => {
    const repoPath = await tempRepo();
    const calls: string[] = [];

    const installed = await ensureCocoaPodsDependencies(repoPath, async (command) => {
      calls.push(command);
      return { stdout: '', stderr: '' };
    });

    expect(installed).toBe(false);
    expect(calls).toEqual([]);
    expect(await hasPodfile(repoPath)).toBe(false);
  });

  it('runs pod install when a Podfile exists', async () => {
    const repoPath = await tempRepo();
    await fs.writeFile(path.join(repoPath, 'Podfile'), "platform :ios, '13.0'\n", 'utf-8');
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

    const installed = await ensureCocoaPodsDependencies(repoPath, async (command, args, cwd) => {
      calls.push({ command, args, cwd });
      return { stdout: '', stderr: '' };
    });

    expect(installed).toBe(true);
    expect(calls).toEqual([
      {
        command: 'pod',
        args: ['install', '--repo-update', '--allow-root', '--no-ansi'],
        cwd: repoPath,
      },
    ]);
    expect(await hasPodfile(repoPath)).toBe(true);
  });

  it('passes the Gitea token to git through temporary URL rewrite env', () => {
    const env = buildCocoaPodsEnv({ GITEA_TOKEN: 'tok/en value' });

    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('url.https://tok%2Fen%20value@code.9ji.com/.insteadOf');
    expect(env.GIT_CONFIG_VALUE_0).toBe('https://code.9ji.com/');
    expect(env.LANG).toBe('C.UTF-8');
  });

  it('keeps stdout and stderr in pod install failures', () => {
    const message = formatPodInstallFailure(
      'Installing MarkdownView\nfatal: could not read Username\n',
      "[!] 'Bugly' uses the unencrypted 'http' protocol\n",
    );

    expect(message).toContain('stdout:');
    expect(message).toContain('fatal: could not read Username');
    expect(message).toContain('stderr:');
    expect(message).toContain('Bugly');
  });
});
