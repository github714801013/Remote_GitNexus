import { EventEmitter } from 'events';
import { mkdtemp } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { ensureLocalWorktree } from '../../src/server/webhook-worktree.js';

const fakeGit = (stdout: string) => {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', 0);
  });
  return proc;
};

describe('webhook worktree git credentials', () => {
  const previousToken = process.env.GITEA_TOKEN;

  beforeEach(() => {
    process.env.GITEA_TOKEN = 'test-token';
    spawnMock.mockReset();
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return fakeGit('https://code.9ji.com/group/api.git\n');
      }
      if (args[0] === 'branch' && args[1] === '--show-current') return fakeGit('dev-api\n');
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return fakeGit('deadbeef\n');
      return fakeGit('');
    });
  });

  afterEach(() => {
    spawnMock.mockReset();
    if (previousToken === undefined) delete process.env.GITEA_TOKEN;
    else process.env.GITEA_TOKEN = previousToken;
  });

  it('sends the Gitea credential on source-ref fetches', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-worktree-auth-test-'));
    const worktreePath = path.join(tempRoot, 'dev-api');

    await ensureLocalWorktree({
      mainRepoPath: path.join(tempRoot, 'main'),
      worktreePath,
      branch: 'dev-api',
      baseRef: 'origin/master',
    });

    const fetchIndex = spawnMock.mock.calls.findIndex(([, args]) => args[0] === 'fetch');
    expect(fetchIndex).toBeGreaterThan(-1);
    const [, fetchArgs, fetchOptions] = spawnMock.mock.calls[fetchIndex];
    expect(fetchArgs).toEqual(['fetch', 'origin', 'master:refs/remotes/origin/master']);

    const headerKey = 'http.https://code.9ji.com/group/api.git.extraHeader';
    const configIndex = Object.entries(fetchOptions.env).find(
      ([key, value]) => /^GIT_CONFIG_KEY_\d+$/.test(key) && value === headerKey,
    )?.[0].slice('GIT_CONFIG_KEY_'.length);
    expect(fetchOptions.env[`GIT_CONFIG_VALUE_${configIndex}`]).toBe(
      `Authorization: Basic ${Buffer.from('test-token:').toString('base64')}`,
    );

    const urlIndex = spawnMock.mock.calls.findIndex(
      ([, args]) => args[0] === 'remote' && args[1] === 'get-url',
    );
    expect(urlIndex).toBeLessThan(fetchIndex);
  });
});
