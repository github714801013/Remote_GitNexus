import { describe, expect, it } from 'vitest';
import {
  STALE_ANALYZE_MAX_PER_ROUND,
  isKnownBranchMismatch,
  selectStaleAnalyzeCandidates,
} from '../../src/server/stale-analyze-scheduler.js';

const candidate = (repoPath: string, commitsBehind: number) => ({ repoPath, commitsBehind });

describe('stale analyze candidate selection', () => {
  it('sorts by commitsBehind descending and keeps only the first 10', () => {
    const candidates = Array.from({ length: 11 }, (_, index) =>
      candidate(`repo-${index}`, 110 + index * 10),
    );

    const selected = selectStaleAnalyzeCandidates(candidates, new Set());

    expect(STALE_ANALYZE_MAX_PER_ROUND).toBe(10);
    expect(selected.map((item) => item.commitsBehind)).toEqual([
      210, 200, 190, 180, 170, 160, 150, 140, 130, 120,
    ]);
    expect(selected.map((item) => item.repoPath)).not.toContain('repo-0');
  });

  it('keeps the input order for equal commitsBehind values', () => {
    const candidates = [
      candidate('first', 100),
      candidate('second', 100),
      candidate('third', 100),
    ];

    expect(selectStaleAnalyzeCandidates(candidates, new Set()).map((item) => item.repoPath)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('filters repositories recorded in the process-scoped failure set', () => {
    const candidates = [candidate('failed', 340), candidate('healthy', 125)];

    const selected = selectStaleAnalyzeCandidates(candidates, new Set(['failed']));

    expect(selected).toEqual([candidate('healthy', 125)]);
  });

  it('drops candidates with zero or negative commitsBehind', () => {
    const candidates = [candidate('zero', 0), candidate('negative', -3), candidate('stale', 17)];

    expect(selectStaleAnalyzeCandidates(candidates, new Set())).toEqual([candidate('stale', 17)]);
  });

  it('returns a previously failed repository again for a fresh failure set', () => {
    const candidates = [candidate('repo', 200)];
    expect(selectStaleAnalyzeCandidates(candidates, new Set())).toEqual(candidates);
  });
});

describe('index branch mismatch detection', () => {
  it('flags only a known index branch that differs from the checkout branch', () => {
    expect(isKnownBranchMismatch('release_9ji', 'release_9ji')).toBe(false);
    expect(isKnownBranchMismatch('main', 'release_9ji')).toBe(true);
  });

  it('treats detached HEAD as a mismatch when the index branch is known', () => {
    expect(isKnownBranchMismatch(null, 'release_9ji')).toBe(true);
  });

  it('keeps legacy entries without an index branch eligible', () => {
    expect(isKnownBranchMismatch('main', undefined)).toBe(false);
    expect(isKnownBranchMismatch('main', '')).toBe(false);
    expect(isKnownBranchMismatch(null, null)).toBe(false);
  });
});
