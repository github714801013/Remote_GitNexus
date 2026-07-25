import { describe, expect, it } from 'vitest';
import {
  ResourceAwareConcurrencyController,
  getResourceAwareConcurrencyConfig,
  isHourInWindow,
} from '../../src/server/resource-aware-concurrency.js';

describe('resource-aware webhook concurrency', () => {
  it('treats 22:00 to 09:00 as an overnight window', () => {
    expect(isHourInWindow(22, 22, 9)).toBe(true);
    expect(isHourInWindow(2, 22, 9)).toBe(true);
    expect(isHourInWindow(8, 22, 9)).toBe(true);
    expect(isHourInWindow(9, 22, 9)).toBe(false);
    expect(isHourInWindow(15, 22, 9)).toBe(false);
  });

  it('enables structure parallelism only inside the window with enough free memory', () => {
    const config = getResourceAwareConcurrencyConfig({
      GITNEXUS_NIGHTLY_PARALLEL_START_HOUR: '22',
      GITNEXUS_NIGHTLY_PARALLEL_END_HOUR: '9',
      GITNEXUS_STRUCTURE_PARALLEL_CONCURRENCY: '3',
      GITNEXUS_STRUCTURE_PARALLEL_FREE_MEMORY_RATIO: '0.4',
    });
    const controller = new ResourceAwareConcurrencyController(config, {
      now: () => new Date('2026-05-31T23:00:00+08:00'),
      readFreeMemoryRatio: () => 0.41,
    });

    expect(controller.getConcurrency('structure')).toBe(3);
  });

  it('keeps structure concurrency conservative outside the configured window', () => {
    const config = getResourceAwareConcurrencyConfig({
      GITNEXUS_NIGHTLY_PARALLEL_START_HOUR: '22',
      GITNEXUS_NIGHTLY_PARALLEL_END_HOUR: '9',
      GITNEXUS_STRUCTURE_PARALLEL_CONCURRENCY: '3',
      GITNEXUS_STRUCTURE_PARALLEL_FREE_MEMORY_RATIO: '0.4',
    });
    const controller = new ResourceAwareConcurrencyController(config, {
      now: () => new Date('2026-05-31T15:00:00+08:00'),
      readFreeMemoryRatio: () => 0.8,
    });

    expect(controller.getConcurrency('structure')).toBe(1);
  });

  it('enables embedding parallelism without checking local GPU memory', () => {
    const config = getResourceAwareConcurrencyConfig({
      GITNEXUS_EMBEDDING_PARALLEL_CONCURRENCY: '4',
    });
    const controller = new ResourceAwareConcurrencyController(config, {
      now: () => new Date('2026-05-31T23:00:00+08:00'),
    });

    expect(controller.getConcurrency('embedding')).toBe(4);
  });

  it('keeps embedding parallelism outside the configured structure window', () => {
    const config = getResourceAwareConcurrencyConfig({
      GITNEXUS_NIGHTLY_PARALLEL_START_HOUR: '22',
      GITNEXUS_NIGHTLY_PARALLEL_END_HOUR: '9',
      GITNEXUS_EMBEDDING_REPAIR_CONCURRENCY: '3',
      GITNEXUS_EMBEDDING_PARALLEL_CONCURRENCY: '3',
    });
    const controller = new ResourceAwareConcurrencyController(config, {
      now: () => new Date('2026-05-31T15:00:00+08:00'),
    });

    expect(controller.getConcurrency('embedding')).toBe(3);
  });

  it('exposes the configured per-queue parallel start stagger', () => {
    const config = getResourceAwareConcurrencyConfig({
      GITNEXUS_PARALLEL_ENTRY_STAGGER_MS: '12345',
    });
    const controller = new ResourceAwareConcurrencyController(config);

    expect(controller.getParallelEntryStaggerMs()).toBe(12345);
  });
});
