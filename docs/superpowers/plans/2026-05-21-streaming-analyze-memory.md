# Streaming Analyze Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce GitNexus analyze worker peak memory for `OA_CSharp/oanew` by removing full graph IPC return and streaming parse-worker results into the in-memory graph as each worker finishes.

**Architecture:** Keep the existing analyzer and LadybugDB CSV/COPY architecture. Make two surgical memory reductions: default `runFullAnalysis` no longer returns `pipelineResult` unless explicitly requested by CLI skills generation, and `WorkerPool.dispatch` can invoke an `onResult` callback so parsing results are merged immediately instead of retained as a full `ParseWorkerResult[]` batch.

**Tech Stack:** TypeScript, Node.js child_process fork IPC, Vitest, GitNexus ingestion worker threads, LadybugDB loader, Docker Compose deploy script.

---

## File Structure

- Modify `gitnexus/src/core/run-analyze.ts`
  - Add `returnPipelineResult?: boolean` to `AnalyzeOptions`.
  - Return `pipelineResult` only when `options.returnPipelineResult` is true.
- Modify `gitnexus/src/cli/analyze.ts`
  - Pass `returnPipelineResult: !!options?.skills` so CLI skill generation keeps its current behavior.
- Modify `gitnexus/src/core/ingestion/workers/worker-pool.ts`
  - Extend `dispatch` with optional `onResult?: (result, workerIndex) => void`.
  - When `onResult` is present, call it per worker result and resolve without returning that result in the aggregate array.
- Modify `gitnexus/src/core/ingestion/parsing-processor.ts`
  - Move result merge logic into a local `mergeWorkerResult` function.
  - Call `workerPool.dispatch(..., ..., mergeWorkerResult)` and avoid storing `chunkResults`.
- Modify `gitnexus/src/core/lbug/csv-generator.ts`
  - Lower file content cache default from 3000 to 300 and allow `GITNEXUS_CSV_CONTENT_CACHE_SIZE` override.
- Add/modify tests:
  - `gitnexus/test/unit/run-analyze-result.test.ts` validates default no `pipelineResult` and opt-in behavior by mocking heavy pipeline dependencies.
  - `gitnexus/test/unit/worker-pool.test.ts` validates streaming callback receives results and returned array does not retain them.
  - `gitnexus/test/unit/csv-generator.test.ts` validates cache size parsing if a helper is exported.
- Modify `docs/superpowers/TODO.md`
  - Sync dev-spec-gen phases for this plan.

## Assumptions and Success Criteria

- Assumption: `oanew` OOM is caused by analyzer heap pressure, not container memory limit; previous evidence showed `OOMKilled=false`, worker had `--max-old-space-size=16384`, and V8 reported JS heap OOM.
- Assumption: External API response shapes are not changing; only analyze worker IPC result shape changes by omitting an internal optional field.
- Success criteria:
  - Unit tests fail before implementation and pass after implementation.
  - `npm run build` in `gitnexus/` passes.
  - `bash mcp_proxy_docker/remote_deploy.sh` deploys successfully.
  - Remote logs show `oanew` analyze completes, or if it fails again, logs identify the exact phase after the new memory reductions.

## Dev-Spec-Gen Required Phases

- Runtime Environment Check: confirm branch and Node project test commands.
- API-First: internal IPC contract is `{ type: 'complete', result: AnalyzeResult }`; `AnalyzeResult.pipelineResult` remains optional and is omitted by server worker by default.
- DB-First: no schema migration; LadybugDB node/relationship schema and COPY loading remain unchanged.
- Bug Reproduction: tests assert the unwanted full `pipelineResult` retention and worker result aggregation behavior.
- Verification Execution: run targeted Vitest tests, then project build, then remote deploy and log polling.
- Compliance Audit: code-reviewer and security-reviewer before declaring completion.

### Task 1: Stop returning full pipeline result by default

**Files:**
- Modify: `gitnexus/src/core/run-analyze.ts:61-115,513-518`
- Modify: `gitnexus/src/cli/analyze.ts:214-231`
- Test: `gitnexus/test/unit/run-analyze-result.test.ts`

- [ ] **Step 1: Write the failing test**

Create `gitnexus/test/unit/run-analyze-result.test.ts` with module mocks so the test checks `runFullAnalysis` return shape without running the real analyzer:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakePipelineResult = {
  graph: { marker: 'large-graph' },
  repoPath: '/repo',
  totalFileCount: 2,
  communityResult: { stats: { totalCommunities: 1 }, communities: [] },
  processResult: { stats: { totalProcesses: 1 } },
};

vi.mock('../../src/core/ingestion/pipeline.js', () => ({
  runPipelineFromRepo: vi.fn(async () => fakePipelineResult),
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  initLbug: vi.fn(async () => {}),
  loadGraphToLbug: vi.fn(async () => {}),
  getLbugStats: vi.fn(async () => ({ nodes: 3, edges: 4 })),
  executeQuery: vi.fn(async () => [{ cnt: 0 }]),
  executeWithReusedStatement: vi.fn(async () => {}),
  ensureFTSIndex: vi.fn(async () => {}),
  closeLbug: vi.fn(async () => {}),
  loadCachedEmbeddings: vi.fn(async () => ({ embeddingNodeIds: new Set(), embeddings: [] })),
  fetchExistingEmbeddingHashes: vi.fn(async () => new Map()),
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  getStoragePaths: vi.fn(() => ({ storagePath: '/tmp/gitnexus-test-index', lbugPath: '/tmp/gitnexus-test-index/index.lbug' })),
  saveMeta: vi.fn(async () => {}),
  loadMeta: vi.fn(async () => null),
  addToGitignore: vi.fn(async () => {}),
  registerRepo: vi.fn(async () => 'repo'),
  cleanupOldKuzuFiles: vi.fn(async () => ({ found: false, needsReindex: false })),
}));

vi.mock('../../src/storage/git.js', () => ({
  getCurrentCommit: vi.fn(() => 'abc123'),
  getCurrentBranch: vi.fn(() => 'main'),
  getRemoteUrl: vi.fn(() => 'https://example.invalid/repo.git'),
  hasGitDir: vi.fn(() => true),
  getInferredRepoName: vi.fn(() => 'repo'),
}));

vi.mock('../../src/cli/ai-context.js', () => ({
  generateAIContextFiles: vi.fn(async () => {}),
}));

vi.mock('../../src/lbug/index-backup.js', async () => {
  const actual = await vi.importActual<any>('../../src/core/lbug/index-backup.js');
  return actual;
});

vi.mock('../../src/core/lbug/index-backup.js', () => ({
  backupLatestIndex: vi.fn(async () => ({ status: 'skipped-invalid-live' })),
  prepareEmbeddingShadowIndex: vi.fn(async () => {}),
  probeLbugFile: vi.fn(async () => ({ ok: true })),
  swapEmbeddingShadowToLive: vi.fn(async () => {}),
}));

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<any>('fs/promises');
  return {
    ...actual,
    rm: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ isFile: () => true })),
  };
});

describe('runFullAnalysis result shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omits pipelineResult by default', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const result = await runFullAnalysis('/repo', { force: true, embeddings: false }, {
      onProgress: vi.fn(),
      onLog: vi.fn(),
    });

    expect(result.pipelineResult).toBeUndefined();
    expect(result.stats).toEqual({ files: 2, nodes: 3, edges: 4, communities: 1, processes: 1, embeddings: 0 });
  });

  it('returns pipelineResult only when explicitly requested', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');

    const result = await runFullAnalysis('/repo', {
      force: true,
      embeddings: false,
      returnPipelineResult: true,
    }, {
      onProgress: vi.fn(),
      onLog: vi.fn(),
    });

    expect(result.pipelineResult).toBe(fakePipelineResult);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
cd gitnexus && npm test -- run-analyze-result.test.ts
```

Expected: FAIL because `AnalyzeOptions` has no `returnPipelineResult` and `runFullAnalysis` always returns `pipelineResult`.

- [ ] **Step 3: Implement minimal opt-in return**

In `gitnexus/src/core/run-analyze.ts`, add this property to `AnalyzeOptions` after `allowDuplicateName?: boolean;`:

```ts
  /** Return raw pipeline artifacts for CLI-only post-processing such as skill generation. */
  returnPipelineResult?: boolean;
```

Replace the final return block with:

```ts
    return {
      repoName: projectName,
      repoPath,
      stats: meta.stats,
      ...(options.returnPipelineResult ? { pipelineResult } : {}),
    };
```

- [ ] **Step 4: Preserve CLI skills behavior**

In `gitnexus/src/cli/analyze.ts`, add `returnPipelineResult: !!options?.skills,` inside the `runFullAnalysis` options object:

```ts
            allowDuplicateName: options?.allowDuplicateName,
            returnPipelineResult: !!options?.skills,
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
cd gitnexus && npm test -- run-analyze-result.test.ts
```

Expected: PASS.

### Task 2: Stream parse worker results into the graph

**Files:**
- Modify: `gitnexus/src/core/ingestion/workers/worker-pool.ts:6-15,65-173`
- Modify: `gitnexus/src/core/ingestion/parsing-processor.ts:112-183`
- Test: `gitnexus/test/unit/worker-pool.test.ts`

- [ ] **Step 1: Write the failing worker-pool test**

Append this test to `gitnexus/test/unit/worker-pool.test.ts` or create the file if it does not exist:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createWorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';

describe('WorkerPool streaming dispatch', () => {
  it('streams worker results through onResult without retaining aggregate results', async () => {
    const streamed: Array<{ workerIndex: number; result: string[] }> = [];
    const pool = createWorkerPool(new URL('./fixtures/echo-worker.js', import.meta.url), 1);

    try {
      const retained = await pool.dispatch<string, string[]>(
        ['a', 'b'],
        vi.fn(),
        (result, workerIndex) => streamed.push({ workerIndex, result }),
      );

      expect(streamed).toEqual([{ workerIndex: 0, result: ['a', 'b'] }]);
      expect(retained).toEqual([]);
    } finally {
      await pool.terminate();
    }
  });
});
```

Create `gitnexus/test/unit/fixtures/echo-worker.js`:

```js
import { parentPort } from 'node:worker_threads';

const items = [];

parentPort.on('message', (msg) => {
  if (msg.type === 'sub-batch') {
    items.push(...msg.files);
    parentPort.postMessage({ type: 'progress', filesProcessed: items.length });
    parentPort.postMessage({ type: 'sub-batch-done' });
  } else if (msg.type === 'flush') {
    parentPort.postMessage({ type: 'result', data: items });
  }
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
cd gitnexus && npm test -- worker-pool.test.ts
```

Expected: FAIL because `dispatch` accepts only two arguments and returns retained results.

- [ ] **Step 3: Extend WorkerPool dispatch signature**

In `gitnexus/src/core/ingestion/workers/worker-pool.ts`, change the interface method to:

```ts
  dispatch<TInput, TResult>(
    items: TInput[],
    onProgress?: (filesProcessed: number) => void,
    onResult?: (result: TResult, workerIndex: number) => void,
  ): Promise<TResult[]>;
```

Change the implementation signature to:

```ts
  const dispatch = <TInput, TResult>(
    items: TInput[],
    onProgress?: (filesProcessed: number) => void,
    onResult?: (result: TResult, workerIndex: number) => void,
  ): Promise<TResult[]> => {
```

Change the `msg.type === 'result'` branch to:

```ts
          } else if (msg.type === 'result') {
            settled = true;
            cleanup();
            const result = msg.data as TResult;
            if (onResult) {
              onResult(result, i);
              resolve(undefined as TResult);
            } else {
              resolve(result);
            }
          }
```

Change the final return from `return Promise.all(promises);` to:

```ts
    return Promise.all(promises).then((results) =>
      onResult ? [] : results,
    );
```

- [ ] **Step 4: Move parser merge into streaming callback**

In `gitnexus/src/core/ingestion/parsing-processor.ts`, replace the `chunkResults` dispatch and both `for (const result of chunkResults)` loops with one local merge function.

Use this code starting at the current comment `// Dispatch to worker pool` through the skipped-language warning:

```ts
  const allImports: ExtractedImport[] = [];
  const allCalls: ExtractedCall[] = [];
  const allAssignments: ExtractedAssignment[] = [];
  const allHeritage: ExtractedHeritage[] = [];
  const allRoutes: ExtractedRoute[] = [];
  const allFetchCalls: ExtractedFetchCall[] = [];
  const allDecoratorRoutes: ExtractedDecoratorRoute[] = [];
  const allToolDefs: ExtractedToolDef[] = [];
  const allORMQueries: ExtractedORMQuery[] = [];
  const allConstructorBindings: FileConstructorBindings[] = [];
  const fileScopeBindingsByFile: FileScopeBindings[] = [];
  const allParsedFiles: ParsedFile[] = [];
  const skippedLanguages = new Map<string, number>();

  const mergeWorkerResult = (result: ParseWorkerResult) => {
    for (const node of result.nodes) {
      graph.addNode({
        id: node.id,
        label: node.label as NodeLabel,
        properties: node.properties,
      });
    }

    for (const rel of result.relationships) {
      graph.addRelationship(rel);
    }

    for (const sym of result.symbols) {
      symbolTable.add(sym.filePath, sym.name, sym.nodeId, sym.type, {
        parameterCount: sym.parameterCount,
        requiredParameterCount: sym.requiredParameterCount,
        parameterTypes: sym.parameterTypes,
        returnType: sym.returnType,
        declaredType: sym.declaredType,
        ownerId: sym.ownerId,
        qualifiedName: sym.qualifiedName,
      });
    }

    for (const item of result.imports) allImports.push(item);
    for (const item of result.calls) allCalls.push(item);
    for (const item of result.assignments) allAssignments.push(item);
    for (const item of result.heritage) allHeritage.push(item);
    for (const item of result.routes) allRoutes.push(item);
    for (const item of result.fetchCalls) allFetchCalls.push(item);
    for (const item of result.decoratorRoutes) allDecoratorRoutes.push(item);
    for (const item of result.toolDefs) allToolDefs.push(item);
    if (result.ormQueries) for (const item of result.ormQueries) allORMQueries.push(item);
    for (const item of result.constructorBindings) allConstructorBindings.push(item);
    if (result.fileScopeBindings)
      for (const item of result.fileScopeBindings) fileScopeBindingsByFile.push(item);
    if (result.parsedFiles) for (const item of result.parsedFiles) allParsedFiles.push(item);

    for (const [lang, count] of Object.entries(result.skippedLanguages)) {
      skippedLanguages.set(lang, (skippedLanguages.get(lang) || 0) + count);
    }
  };

  await workerPool.dispatch<ParseWorkerInput, ParseWorkerResult>(
    parseableFiles,
    (filesProcessed) => {
      onFileProgress?.(Math.min(filesProcessed, total), total, 'Parsing...');
    },
    mergeWorkerResult,
  );

  if (skippedLanguages.size > 0) {
    const summary = Array.from(skippedLanguages.entries())
      .map(([lang, count]) => `${lang}: ${count}`)
      .join(', ');
    console.warn(`  Skipped unsupported languages: ${summary}`);
  }
```

- [ ] **Step 5: Run parser/worker tests**

Run:

```bash
cd gitnexus && npm test -- worker-pool.test.ts
```

Expected: PASS.

### Task 3: Reduce CSV content cache peak memory

**Files:**
- Modify: `gitnexus/src/core/lbug/csv-generator.ts:68-82`
- Test: `gitnexus/test/unit/csv-generator.test.ts`

- [ ] **Step 1: Write the failing cache-size test**

Append to `gitnexus/test/unit/csv-generator.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getCSVContentCacheSize } from '../../src/core/lbug/csv-generator.js';

describe('getCSVContentCacheSize', () => {
  it('defaults to 300 files', () => {
    expect(getCSVContentCacheSize(undefined)).toBe(300);
  });

  it('uses a positive integer override', () => {
    expect(getCSVContentCacheSize('50')).toBe(50);
  });

  it('falls back for invalid overrides', () => {
    expect(getCSVContentCacheSize('0')).toBe(300);
    expect(getCSVContentCacheSize('abc')).toBe(300);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
cd gitnexus && npm test -- csv-generator.test.ts
```

Expected: FAIL because `getCSVContentCacheSize` is not exported.

- [ ] **Step 3: Implement cache-size helper**

In `gitnexus/src/core/lbug/csv-generator.ts`, add near `FLUSH_EVERY`:

```ts
const DEFAULT_CONTENT_CACHE_SIZE = 300;

export const getCSVContentCacheSize = (
  raw = process.env.GITNEXUS_CSV_CONTENT_CACHE_SIZE,
): number => {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTENT_CACHE_SIZE;
};
```

Change the `FileContentCache` constructor default from `3000` to:

```ts
  constructor(repoPath: string, maxSize: number = getCSVContentCacheSize()) {
```

- [ ] **Step 4: Run cache test**

Run:

```bash
cd gitnexus && npm test -- csv-generator.test.ts
```

Expected: PASS.

### Task 4: Run targeted validation and build

**Files:**
- No source changes expected.

- [ ] **Step 1: Run targeted unit tests**

Run:

```bash
cd gitnexus && npm test -- run-analyze-result.test.ts worker-pool.test.ts csv-generator.test.ts analyze-worker-options.test.ts webhook-worktree.test.ts
```

Expected: PASS for all targeted tests.

- [ ] **Step 2: Run project build**

Run:

```bash
cd gitnexus && npm run build
```

Expected: PASS with no TypeScript errors.

### Task 5: Review changes before deploy

**Files:**
- Source files changed in Tasks 1-3.

- [ ] **Step 1: Run code reviewer**

Use `code-reviewer` agent with this prompt:

```text
Review the memory optimization changes for GitNexus analyze. Focus on TypeScript correctness, IPC contract compatibility, worker-pool streaming behavior, and whether any changed tests are brittle. Report CRITICAL/HIGH/MEDIUM issues only.
```

Expected: no CRITICAL or HIGH issues. Fix any CRITICAL/HIGH before continuing.

- [ ] **Step 2: Run security reviewer**

Use `security-reviewer` agent with this prompt:

```text
Review the analyze worker and worker-pool memory optimization changes. Focus on command execution, path handling, environment variable parsing, worker IPC message handling, and whether any change exposes secrets or weakens validation. Report CRITICAL/HIGH/MEDIUM issues only.
```

Expected: no CRITICAL or HIGH issues. Fix any CRITICAL/HIGH before continuing.

### Task 6: Deploy and observe `oanew` indexing

**Files:**
- Execute: `mcp_proxy_docker/remote_deploy.sh`

- [ ] **Step 1: Deploy with the existing script**

Run from repo root:

```bash
cd /d/workplace/typescript/GitNexus && bash mcp_proxy_docker/remote_deploy.sh
```

Expected: Docker image builds, transfers to `ji99@10.1.14.177`, `docker compose up -d` succeeds, and `auto_verify.py` passes.

- [ ] **Step 2: Trigger or wait for `oanew` analyze**

If no webhook is already running, use the existing deployment/webhook mechanism already used in this session to trigger `/webhook/dev/index` for `OA_CSharp/oanew`.

Expected: server logs contain `[webhook] received` and `[webhook] analyze started` for `/projects/OA_CSharp/oanew`.

- [ ] **Step 3: Poll remote logs until completion or failure**

Run a bounded SSH log check repeatedly with 60-120 seconds between checks:

```bash
ssh ji99@10.1.14.177 "cd /home/ji99/Project/mcp_gitnexus_server && docker compose logs --tail=300 gitnexus-mcp-proxy | grep -E 'oanew|analyze completed|analyze failed|JavaScript heap|FATAL ERROR|Loading into LadybugDB|Creating search indexes|Done'"
```

Expected completion evidence:

```text
[webhook] analyze completed jobId=... repoPath=/projects/OA_CSharp/oanew
```

Failure evidence to capture if it still fails:

```text
FATAL ERROR: ... JavaScript heap out of memory
[webhook] analyze failed repoPath=/projects/OA_CSharp/oanew: ...
```

- [ ] **Step 4: Verify registry/index state after completion**

Use GitNexus MCP or remote registry inspection to confirm `oanew` last commit/index metadata changed after completion.

Expected: `oanew` indexed metadata has a fresh `indexedAt` timestamp and no current failed analyze job.

## Self-Review

- Spec coverage: covers memory OOM mitigation, tests, deployment, and log observation until `oanew` completes.
- Placeholder scan: no TBD/TODO/fill-in placeholders; every implementation step has concrete code or command.
- Type consistency: `returnPipelineResult` is defined in `AnalyzeOptions`, used only by CLI; `WorkerPool.dispatch` callback type matches parser usage.
