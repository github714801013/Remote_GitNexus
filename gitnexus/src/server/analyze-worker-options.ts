const FALLBACK_ANALYZE_WORKER_HEAP_MB = 32768;

export const getAnalyzeWorkerHeapMb = (
  rawValue: string | undefined,
  fallback = FALLBACK_ANALYZE_WORKER_HEAP_MB,
): number => {
  if (!rawValue) return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

export const buildAnalyzeWorkerExecArgv = (
  prefixArgs: string[] = [],
  rawHeapMb = process.env.GITNEXUS_ANALYZE_MAX_OLD_SPACE_MB,
): string[] => [...prefixArgs, `--max-old-space-size=${getAnalyzeWorkerHeapMb(rawHeapMb)}`];
