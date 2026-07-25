import { describe, expect, it } from 'vitest';
import {
  buildAnalyzeWorkerExecArgv,
  getAnalyzeWorkerHeapMb,
} from '../../src/server/analyze-worker-options.js';

describe('analyze worker options', () => {
  it('uses 32768 MB by default', () => {
    expect(getAnalyzeWorkerHeapMb(undefined)).toBe(32768);
    expect(buildAnalyzeWorkerExecArgv([])).toEqual(['--max-old-space-size=32768']);
  });

  it('uses the configured worker heap size', () => {
    expect(getAnalyzeWorkerHeapMb('24576')).toBe(24576);
    expect(buildAnalyzeWorkerExecArgv(['--import', 'tsx'], '24576')).toEqual([
      '--import',
      'tsx',
      '--max-old-space-size=24576',
    ]);
  });

  it('falls back when the configured heap size is invalid', () => {
    expect(getAnalyzeWorkerHeapMb('abc')).toBe(32768);
    expect(getAnalyzeWorkerHeapMb('-1')).toBe(32768);
  });
});
