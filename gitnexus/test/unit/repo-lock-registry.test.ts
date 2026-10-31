import { describe, expect, it, vi } from 'vitest';
import { RepoLockRegistry } from '../../src/server/repo-lock-registry.js';

describe('RepoLockRegistry', () => {
  it('notifies all listeners only when a held key is released', () => {
    const registry = new RepoLockRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.onReleased(first);
    registry.onReleased(second);

    expect(registry.acquire('repo-a')).toBeNull();
    registry.release('repo-a');
    registry.release('repo-a');

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith('repo-a');
    expect(registry.has('repo-a')).toBe(false);
  });
});
