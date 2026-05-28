import { describe, it, expect } from 'vitest';
import {
  buildWebhookBranchSyncCommands,
  extractRepoName,
  getAuthenticatedGitUrl,
  getCloneDir,
  validateGitUrl,
} from '../../src/server/git-clone.js';

describe('git-clone', () => {
  describe('extractRepoName', () => {
    it('extracts name from HTTPS URL', () => {
      expect(extractRepoName('https://github.com/user/my-repo.git')).toBe('my-repo');
    });

    it('extracts name from HTTPS URL without .git suffix', () => {
      expect(extractRepoName('https://github.com/user/my-repo')).toBe('my-repo');
    });

    it('extracts name from SSH URL', () => {
      expect(extractRepoName('git@github.com:user/my-repo.git')).toBe('my-repo');
    });

    it('handles trailing slashes', () => {
      expect(extractRepoName('https://github.com/user/my-repo/')).toBe('my-repo');
    });

    it('handles nested paths', () => {
      expect(extractRepoName('https://gitlab.com/group/subgroup/repo.git')).toBe('repo');
    });
  });

  describe('getCloneDir', () => {
    it('returns path under ~/.gitnexus/repos/', () => {
      const dir = getCloneDir('my-repo');
      expect(dir).toContain('.gitnexus');
      expect(dir).toMatch(/repos/);
      expect(dir).toContain('my-repo');
    });
  });

  describe('validateGitUrl', () => {
    it('allows valid HTTPS GitHub URLs', () => {
      expect(() => validateGitUrl('https://github.com/user/repo.git')).not.toThrow();
      expect(() => validateGitUrl('https://github.com/user/repo')).not.toThrow();
    });

    it('allows valid HTTP URLs', () => {
      expect(() => validateGitUrl('http://gitlab.com/user/repo.git')).not.toThrow();
    });

    it('blocks SSH protocol', () => {
      expect(() => validateGitUrl('ssh://git@github.com/user/repo.git')).toThrow(
        'Only https:// and http://',
      );
    });

    it('blocks file:// protocol', () => {
      expect(() => validateGitUrl('file:///etc/passwd')).toThrow('Only https:// and http://');
    });

    it('blocks IPv4 loopback', () => {
      expect(() => validateGitUrl('http://127.0.0.1/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://127.255.0.1/repo.git')).toThrow('private/internal');
    });

    it('blocks IPv6 loopback ::1', () => {
      // Node URL parser strips brackets: hostname is "::1" not "[::1]"
      expect(() => validateGitUrl('http://[::1]/repo.git')).toThrow('private/internal');
    });

    it('blocks IPv4 private ranges (10.x, 172.16-31.x, 192.168.x)', () => {
      expect(() => validateGitUrl('http://10.0.0.1/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://172.16.0.1/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://172.31.255.255/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://192.168.1.1/repo.git')).toThrow('private/internal');
    });

    it('blocks link-local addresses', () => {
      expect(() => validateGitUrl('http://169.254.1.1/repo.git')).toThrow('private/internal');
    });

    it('blocks cloud metadata hostname', () => {
      expect(() => validateGitUrl('http://metadata.google.internal/repo')).toThrow(
        'private/internal',
      );
      expect(() => validateGitUrl('http://metadata.azure.com/repo')).toThrow('private/internal');
    });

    it('blocks IPv6 ULA (fc/fd)', () => {
      expect(() => validateGitUrl('http://[fc00::1]/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://[fd12::1]/repo.git')).toThrow('private/internal');
    });

    it('blocks IPv6 link-local (fe80)', () => {
      expect(() => validateGitUrl('http://[fe80::1]/repo.git')).toThrow('private/internal');
    });

    it('blocks IPv4-mapped IPv6', () => {
      expect(() => validateGitUrl('http://[::ffff:127.0.0.1]/repo.git')).toThrow(
        'private/internal',
      );
    });

    it('does not block valid public IPs', () => {
      expect(() => validateGitUrl('https://140.82.121.4/repo.git')).not.toThrow();
    });

    it('blocks CGN range (100.64.0.0/10)', () => {
      expect(() => validateGitUrl('http://100.64.0.1/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://100.127.255.255/repo.git')).toThrow('private/internal');
    });

    it('blocks benchmarking range (198.18.0.0/15)', () => {
      expect(() => validateGitUrl('http://198.18.0.1/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://198.19.255.255/repo.git')).toThrow('private/internal');
    });

    it('blocks numeric decimal IP encoding', () => {
      expect(() => validateGitUrl('http://2130706433/repo.git')).toThrow('private/internal');
    });

    it('blocks hex IP encoding', () => {
      expect(() => validateGitUrl('http://0x7f000001/repo.git')).toThrow('private/internal');
    });

    it('blocks 0.0.0.0', () => {
      expect(() => validateGitUrl('http://0.0.0.0/repo.git')).toThrow('private/internal');
    });
  });

  describe('buildWebhookBranchSyncCommands', () => {
    it('uses stable remote-tracking refs so divergent local webhook mirrors do not depend on FETCH_HEAD', () => {
      expect(buildWebhookBranchSyncCommands('https://example.com/org/repo.git', 'dev')).toEqual([
        ['remote', 'set-url', 'origin', 'https://example.com/org/repo.git'],
        ['fetch', 'origin', '+refs/heads/dev:refs/remotes/origin/dev', '--depth', '1'],
        ['reset', '--hard', 'refs/remotes/origin/dev'],
        ['clean', '-fd', '-e', '.gitnexus', '-e', '.gitnexus/'],
        ['checkout', '-B', 'dev', 'refs/remotes/origin/dev'],
        ['reset', '--hard', 'refs/remotes/origin/dev'],
        ['clean', '-fd', '-e', '.gitnexus', '-e', '.gitnexus/'],
      ]);
    });

    it('rejects unsafe webhook branch names before building git commands', () => {
      expect(() =>
        buildWebhookBranchSyncCommands('https://example.com/org/repo.git', '../dev'),
      ).toThrow('Invalid branch');
    });
  });

  describe('getAuthenticatedGitUrl', () => {
    it('injects GITEA_TOKEN for webhook git HTTP URLs without changing the persisted URL', () => {
      const original = process.env.GITEA_TOKEN;
      process.env.GITEA_TOKEN = 'secret-token';
      try {
        expect(getAuthenticatedGitUrl('https://code.9ji.com/org/repo.git')).toBe(
          'https://secret-token@code.9ji.com/org/repo.git',
        );
      } finally {
        if (original === undefined) delete process.env.GITEA_TOKEN;
        else process.env.GITEA_TOKEN = original;
      }
    });

    it('leaves URLs unchanged when GITEA_TOKEN is not configured', () => {
      const original = process.env.GITEA_TOKEN;
      delete process.env.GITEA_TOKEN;
      try {
        expect(getAuthenticatedGitUrl('https://code.9ji.com/org/repo.git')).toBe(
          'https://code.9ji.com/org/repo.git',
        );
      } finally {
        if (original !== undefined) process.env.GITEA_TOKEN = original;
      }
    });
  });
});
