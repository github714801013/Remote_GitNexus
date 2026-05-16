# Zoekt Integration Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Zoekt as a high-precision retrieval channel in the `query` tool and make it configurable via environment variables.

**Architecture:**
- Update `ZoektConfig` and `loadZoektConfig` to include an `enabled` flag, controlled by `ZOEKT_ENABLED`.
- Modify `LocalBackend.query` to include a Zoekt search path using `ZoektClient`, scoped to the current repository.
- Update RRF merging logic in `LocalBackend.query` to incorporate Zoekt results alongside BM25 and Semantic results.
- Ensure independent `zoekt_search` and `zoekt_symbol` tools respect the `enabled` flag.

**Tech Stack:** TypeScript, Node.js, Zoekt REST API

---

## File Structure

- `gitnexus/src/core/search/zoekt-client.ts`: Update config and client logic.
- `gitnexus/src/mcp/local/local-backend.ts`: Integrate Zoekt into the `query` tool and add enablement checks.
- `gitnexus/test/unit/zoekt-client.test.ts`: Update unit tests for the new configuration.

---

## Task 1: Update Zoekt Configuration and Enablement

**Files:**
- Modify: `gitnexus/src/core/search/zoekt-client.ts`
- Modify: `gitnexus/src/mcp/local/local-backend.ts`

- [ ] **Step 1: Add `enabled` flag to `ZoektConfig` and `loadZoektConfig`**

```typescript
// gitnexus/src/core/search/zoekt-client.ts

export interface ZoektConfig {
  /** 是否启用 Zoekt */
  enabled: boolean;
  /** Zoekt webserver 端点列表... */
  endpoints: string[];
  // ...
}

export function loadZoektConfig(): ZoektConfig {
  const enabled = process.env.ZOEKT_ENABLED === 'true' || !!(process.env.ZOEKT_ENDPOINTS || process.env.ZOEKT_URL);
  // ...
  return {
    enabled,
    endpoints: endpoints.length > 0 ? endpoints : ['http://localhost:6070'],
    timeoutMs: 10_000,
  };
}
```

- [ ] **Step 2: Update `ZoektClient` methods to handle disabled state (optional but good for safety)**

- [ ] **Step 3: Update `zoektSearch` and `zoektSymbol` in `local-backend.ts` to check `enabled`**

```typescript
// gitnexus/src/mcp/local/local-backend.ts

  private async zoektSearch(params: any): Promise<string> {
    const { ZoektClient, loadZoektConfig } = await import('../../core/search/zoekt-client.js');
    const config = loadZoektConfig();
    if (!config.enabled) {
      return 'Zoekt search is disabled. Set ZOEKT_ENABLED=true or provide ZOEKT_ENDPOINTS to enable it.';
    }
    const client = new ZoektClient(config);
    // ...
  }
```

- [ ] **Step 4: Commit**

```bash
git add gitnexus/src/core/search/zoekt-client.ts gitnexus/src/mcp/local/local-backend.ts
git commit -m "feat: add ZOEKT_ENABLED configuration and enablement checks"
```

---

## Task 2: Integrate Zoekt into the `query` tool

**Files:**
- Modify: `gitnexus/src/mcp/local/local-backend.ts`

- [ ] **Step 1: Add Zoekt search path to `LocalBackend.query`**

In `LocalBackend.query`, add Zoekt search to the `Promise.all` block.

```typescript
// gitnexus/src/mcp/local/local-backend.ts

    const { ZoektClient, loadZoektConfig } = await import('../../core/search/zoekt-client.js');
    const zoektCfg = loadZoektConfig();

    const [bm25SearchResult, semanticResults, zoektResults] = await Promise.all([
      timer.time('bm25', this.bm25Search(repo, searchQuery, searchLimit)),
      timer.time('vector', this.semanticSearch(repo, searchQuery, searchLimit)),
      zoektCfg.enabled 
        ? timer.time('zoekt', new ZoektClient(zoektCfg).search(searchQuery, { repoFilter: repo.name, maxDocDisplayCount: searchLimit }))
        : Promise.resolve({ matches: [] })
    ]);
```

- [ ] **Step 2: Update RRF merging to include Zoekt matches**

```typescript
// gitnexus/src/mcp/local/local-backend.ts

    // ... in the merge loop ...
    if (zoektResults && 'matches' in zoektResults) {
      const matches = (zoektResults as any).matches;
      for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const key = match.fileName; // Zoekt matches are files
        const rrfScore = 1 / (60 + i);
        // ... update scoreMap ...
      }
    }
```

Wait, Zoekt matches need to be converted to symbol-like entries if they are files, or if Zoekt found symbols, use them. 
Actually, Zoekt `search` returns files with line matches. I should probably treat them as "File" type or extract symbols if possible.
In `zoekt接入方式改造.md`, it says Zoekt is for "exact / regex / substring".

- [ ] **Step 3: Run tests to verify integration**

- [ ] **Step 4: Commit**

```bash
git add gitnexus/src/mcp/local/local-backend.ts
git commit -m "feat: integrate Zoekt into multi-retrieval query tool"
```

---

## Task 3: Update and Add Tests

**Files:**
- Modify: `gitnexus/test/unit/zoekt-client.test.ts`
- Create: `gitnexus/test/unit/zoekt-query-integration.test.ts` (optional)

- [ ] **Step 1: Update `loadZoektConfig` tests**

- [ ] **Step 2: Run all tests**

```bash
cd gitnexus && npx vitest run
```

- [ ] **Step 3: Commit**

```bash
git add gitnexus/test/unit/zoekt-client.test.ts
git commit -m "test: update tests for Zoekt configuration"
```
