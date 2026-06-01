import os from 'os';

export type ResourceQueueKind = 'structure' | 'embedding';

const DEFAULT_PARALLEL_START_HOUR = 22;
const DEFAULT_PARALLEL_END_HOUR = 9;
const DEFAULT_RESOURCE_FREE_RATIO = 0.4;
const DEFAULT_PARALLEL_CONCURRENCY = 2;
const DEFAULT_PARALLEL_ENTRY_STAGGER_MS = 5 * 60 * 1000;

interface ResourceAwareConcurrencyConfig {
  enabled: boolean;
  startHour: number;
  endHour: number;
  structureBaseConcurrency: number;
  embeddingBaseConcurrency: number;
  structureParallelConcurrency: number;
  embeddingParallelConcurrency: number;
  minFreeMemoryRatio: number;
  entryStaggerMs: number;
}

interface ResourceAwareConcurrencyOptions {
  now?: () => Date;
  readFreeMemoryRatio?: () => number;
}

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseNonNegativeInt = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseHour = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : fallback;
};

const parseRatio = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
};

export const isHourInWindow = (hour: number, startHour: number, endHour: number): boolean => {
  if (startHour === endHour) return true;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
};

export const readSystemFreeMemoryRatio = (): number => os.freemem() / os.totalmem();

export const getResourceAwareConcurrencyConfig = (
  env: NodeJS.ProcessEnv = process.env,
): ResourceAwareConcurrencyConfig => {
  const structureBaseConcurrency = parsePositiveInt(
    env.GITNEXUS_WEBHOOK_ANALYZE_CONCURRENCY || env.INDEXING_CONCURRENCY,
    1,
  );
  const embeddingBaseConcurrency = parsePositiveInt(env.GITNEXUS_EMBEDDING_REPAIR_CONCURRENCY, 1);
  return {
    enabled: parseBoolean(env.GITNEXUS_NIGHTLY_PARALLEL_ENABLED, true),
    startHour: parseHour(env.GITNEXUS_NIGHTLY_PARALLEL_START_HOUR, DEFAULT_PARALLEL_START_HOUR),
    endHour: parseHour(env.GITNEXUS_NIGHTLY_PARALLEL_END_HOUR, DEFAULT_PARALLEL_END_HOUR),
    structureBaseConcurrency,
    embeddingBaseConcurrency,
    structureParallelConcurrency: parsePositiveInt(
      env.GITNEXUS_STRUCTURE_PARALLEL_CONCURRENCY,
      Math.max(DEFAULT_PARALLEL_CONCURRENCY, structureBaseConcurrency),
    ),
    embeddingParallelConcurrency: parsePositiveInt(
      env.GITNEXUS_EMBEDDING_PARALLEL_CONCURRENCY,
      Math.max(DEFAULT_PARALLEL_CONCURRENCY, embeddingBaseConcurrency),
    ),
    minFreeMemoryRatio: parseRatio(
      env.GITNEXUS_STRUCTURE_PARALLEL_FREE_MEMORY_RATIO,
      DEFAULT_RESOURCE_FREE_RATIO,
    ),
    entryStaggerMs: parseNonNegativeInt(
      env.GITNEXUS_PARALLEL_ENTRY_STAGGER_MS,
      DEFAULT_PARALLEL_ENTRY_STAGGER_MS,
    ),
  };
};

export class ResourceAwareConcurrencyController {
  private readonly config: ResourceAwareConcurrencyConfig;
  private readonly now: () => Date;
  private readonly readFreeMemoryRatio: () => number;
  private readonly parallelByKind: Record<ResourceQueueKind, boolean> = {
    structure: false,
    embedding: false,
  };

  constructor(
    config = getResourceAwareConcurrencyConfig(),
    options: ResourceAwareConcurrencyOptions = {},
  ) {
    this.config = config;
    this.now = options.now ?? (() => new Date());
    this.readFreeMemoryRatio = options.readFreeMemoryRatio ?? readSystemFreeMemoryRatio;
  }

  getConcurrency(kind: ResourceQueueKind): number {
    const baseConcurrency =
      kind === 'structure'
        ? this.config.structureBaseConcurrency
        : this.config.embeddingBaseConcurrency;
    if (kind === 'structure' && !this.canTryParallelWindow()) {
      this.parallelByKind[kind] = false;
      return baseConcurrency;
    }

    const targetConcurrency = this.getResourceQualifiedConcurrency(kind, baseConcurrency);
    if (targetConcurrency <= baseConcurrency) {
      this.parallelByKind[kind] = false;
      return baseConcurrency;
    }

    if (!this.parallelByKind[kind]) {
      this.parallelByKind[kind] = true;
      console.info(
        `[webhook] ${kind} queue entered resource-aware parallel mode concurrency=${targetConcurrency}`,
      );
    }

    return targetConcurrency;
  }

  getParallelEntryStaggerMs(): number {
    return this.config.entryStaggerMs;
  }

  private canTryParallelWindow(): boolean {
    if (!this.config.enabled) return false;
    return isHourInWindow(this.now().getHours(), this.config.startHour, this.config.endHour);
  }

  private getResourceQualifiedConcurrency(
    kind: ResourceQueueKind,
    baseConcurrency: number,
  ): number {
    if (kind === 'structure') {
      const freeMemoryRatio = this.readFreeMemoryRatio();
      if (freeMemoryRatio < this.config.minFreeMemoryRatio) return baseConcurrency;
      return Math.max(baseConcurrency, this.config.structureParallelConcurrency);
    }

    return Math.max(baseConcurrency, this.config.embeddingParallelConcurrency);
  }
}
