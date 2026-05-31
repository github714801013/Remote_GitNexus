# Neo4j CodeNode Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Neo4j relationship writes from running label-free endpoint scans and oversized transactions during GitNexus indexing.

**Architecture:** Add a shared `CodeNode` label to all graph code nodes, create a repo-scoped uniqueness constraint for that shared label, and match relationship endpoints through the shared label. Split relationship writes into bounded transaction chunks so one large relationship type cannot create a multi-hour transaction.

**Tech Stack:** TypeScript, Node.js, Vitest, Neo4j driver.

---

### Task 1: Schema Constraint

**Files:**
- Modify: `gitnexus/src/core/neo4j/schema.ts`
- Test: `gitnexus/test/unit/neo4j-schema.test.ts`

- [x] **Step 1: Write the failing test**

Add a Vitest assertion that `getNeo4jSchemaStatements()` includes:

```typescript
'CREATE CONSTRAINT gitnexus_CodeNode_repo_id IF NOT EXISTS FOR (n:`CodeNode`) REQUIRE (n.repoId, n.id) IS UNIQUE'
```

- [x] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- test/unit/neo4j-schema.test.ts test/unit/neo4j-write-adapter.test.ts
```

Expected before implementation: failure because the shared `CodeNode` constraint is missing.

- [x] **Step 3: Add minimal schema implementation**

Add a `CodeNode` label constant and include its constraint before label-specific node constraints.

- [x] **Step 4: Run schema/write adapter tests**

Run:

```powershell
npm test -- test/unit/neo4j-schema.test.ts test/unit/neo4j-write-adapter.test.ts
```

Expected: schema constraint assertion passes.

### Task 2: Write Adapter Endpoint Lookup

**Files:**
- Modify: `gitnexus/src/core/neo4j/write-adapter.ts`
- Test: `gitnexus/test/unit/neo4j-write-adapter.test.ts`

- [x] **Step 1: Write failing tests**

Update node upsert expectation to merge nodes with both business label and shared `CodeNode` label:

```cypher
MERGE (n:`Function`:`CodeNode` {repoId: $repoId, id: row.id})
```

Update relationship endpoint expectation to match the shared label:

```cypher
MATCH (from:`CodeNode` {repoId: $repoId, id: row.fromId})
MATCH (to:`CodeNode` {repoId: $repoId, id: row.toId})
```

- [x] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- test/unit/neo4j-schema.test.ts test/unit/neo4j-write-adapter.test.ts
```

Expected before implementation: failure because node labels and endpoint lookup still use old Cypher.

- [x] **Step 3: Add minimal write implementation**

Use the shared `CodeNode` label in node merge and relationship endpoint `MATCH` statements.

- [x] **Step 4: Run write adapter tests**

Run:

```powershell
npm test -- test/unit/neo4j-schema.test.ts test/unit/neo4j-write-adapter.test.ts
```

Expected: node and relationship query assertions pass.

### Task 3: Relationship Transaction Bound

**Files:**
- Modify: `gitnexus/src/core/neo4j/write-adapter.ts`
- Test: `gitnexus/test/unit/neo4j-write-adapter.test.ts`

- [x] **Step 1: Write failing test**

Add a test with 1201 `CALLS` relationships and assert `executeWrite` receives three batches of sizes `[500, 500, 201]`.

- [x] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- test/unit/neo4j-schema.test.ts test/unit/neo4j-write-adapter.test.ts
```

Expected before implementation: failure because all relationships are written in one transaction.

- [x] **Step 3: Add minimal batching implementation**

Define a named write batch size constant and execute one transaction per relationship type chunk.

- [ ] **Step 4: Run focused and regression tests**

Run:

```powershell
npm test -- analyze-api.test.ts test/unit/neo4j-schema.test.ts test/unit/neo4j-write-adapter.test.ts
npx tsc --noEmit
git diff --check -- gitnexus/src/core/neo4j/schema.ts gitnexus/src/core/neo4j/write-adapter.ts gitnexus/test/unit/neo4j-schema.test.ts gitnexus/test/unit/neo4j-write-adapter.test.ts gitnexus/src/server/api.ts gitnexus/test/unit/analyze-api.test.ts docs/superpowers/TODO.md docs/superpowers/plans/2026-05-31-neo4j-codenode-batching.md
```

Expected: all commands exit 0.

### Task 4: Audit And Staging

**Files:**
- Review: `git diff`
- Stage: only files changed in this task

- [ ] **Step 1: Check local diff**

Run:

```powershell
git diff -- gitnexus/src/core/neo4j/schema.ts gitnexus/src/core/neo4j/write-adapter.ts gitnexus/test/unit/neo4j-schema.test.ts gitnexus/test/unit/neo4j-write-adapter.test.ts gitnexus/src/server/api.ts gitnexus/test/unit/analyze-api.test.ts docs/superpowers/TODO.md docs/superpowers/plans/2026-05-31-neo4j-codenode-batching.md
```

- [ ] **Step 2: Precisely stage this task's files**

Run `git add` with the explicit file list above. Do not stage unrelated payload files, stack dumps, or older plan/spec files.

- [ ] **Step 3: Verify staged file list**

Run:

```powershell
git diff --cached --name-only
```

Expected: only this task's changed files appear.

### Task 5: Delete Batching And Remote Transaction Cleanup

**Files:**
- Modify: `gitnexus/src/core/neo4j/write-adapter.ts`
- Test: `gitnexus/test/unit/neo4j-write-adapter.test.ts`

- [x] **Step 1: Write the failing test**

Update `clearRepoIndex` coverage to require label-scoped delete batches:

```cypher
MATCH (n:`CodeNode` {repoId: $repoId})
WITH n LIMIT $batchSize
DETACH DELETE n
RETURN count(n) AS deleted
```

Also verify `CodeEmbedding` nodes are deleted separately.

- [x] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- test/unit/neo4j-write-adapter.test.ts
```

Expected before implementation: failure because `clearRepoIndex` still uses label-free `MATCH (n {repoId: $repoId}) DETACH DELETE n`.

- [x] **Step 3: Implement minimal delete batching**

Delete `CodeNode` and `CodeEmbedding` nodes in `WRITE_BATCH_SIZE` chunks, looping while a full batch is deleted.

- [x] **Step 4: Clean remote long-running transactions**

Use `SHOW TRANSACTIONS` to confirm old label-free relationship writes, then terminate only those old GitNexus write transactions. Re-run `SHOW TRANSACTIONS` to confirm no long-running writes remain.

- [ ] **Step 5: Run full verification again**

Run:

```powershell
npm test -- analyze-api.test.ts test/unit/neo4j-schema.test.ts test/unit/neo4j-write-adapter.test.ts
npx tsc --noEmit
git diff --cached --check
```
