# Robust Indexing: Shadow Swap & Auto-Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure database integrity against power outages via Shadow Indexing and Auto-Repair.

**Architecture:**
1.  **Auto-Repair:** Modify `lbug-adapter.ts` to detect corruption during `initLbug` and automatically purge/retry.
2.  **Shadow Indexing:** Modify `run-analyze.ts` to perform indexing into a `.tmp` file and atomically swap it to the live location only upon successful completion.

**Tech Stack:** Node.js, TypeScript, LadybugDB (Kuzu), `fs/promises`.

---

### Task 1: Auto-Repair Implementation

**Files:**
- Modify: `gitnexus/src/core/lbug/lbug-adapter.ts`

- [ ] **Step 1: Implement corruption detection and automatic purge in `doInitLbug`**

```typescript
// Around line 360 in gitnexus/src/core/lbug/lbug-adapter.ts
  try {
    try {
      db = new lbug.Database(dbPath);
      conn = new lbug.Connection(db);
    } catch (e: any) {
      const msg = String(e.message || e).toLowerCase();
      const isCorruption = 
        msg.includes('corrupt') || 
        msg.includes('checksum') || 
        msg.includes('invalid wal') ||
        msg.includes('unreachable');
      
      if (isCorruption) {
        console.warn(`[lbug] Database corruption detected for ${dbPath}. Attempting auto-repair...`);
        // Cleanup handles
        try { if (conn) await conn.close(); } catch {}
        try { if (db) await db.close(); } catch {}
        conn = null;
        db = null;

        // Purge files
        const filesToPurge = [dbPath, `${dbPath}.wal`, `${dbPath}.lock`, `${dbPath}.tmp`];
        for (const f of filesToPurge) {
          try { await fs.rm(f, { force: true, recursive: true }); } catch {}
        }

        // Retry once
        db = new lbug.Database(dbPath);
        conn = new lbug.Connection(db);
      } else {
        throw e;
      }
    }
```

- [ ] **Step 2: Commit Auto-Repair change**

```bash
git add gitnexus/src/core/lbug/lbug-adapter.ts
git commit -m "fix(lbug): add auto-repair for corrupted databases on startup"
```

---

### Task 2: Shadow Indexing Implementation

**Files:**
- Modify: `gitnexus/src/core/run-analyze.ts`

- [ ] **Step 1: Define shadow path and update Phase 2 to build into the shadow index**

```typescript
// Around line 140 in gitnexus/src/core/run-analyze.ts
  const lbugPath = path.join(storagePath, 'lbug');
  const lbugShadowPath = `${lbugPath}.shadow`; // Define shadow path
```

- [ ] **Step 2: Modify Phase 2 to initialize and write to `lbugShadowPath`**

```typescript
// Around line 195 in Phase 2
  progress('lbug', 60, 'Loading into LadybugDB (Shadow Build)...');

  await closeLbug();
  // Clear any existing shadow files
  const shadowFiles = [lbugShadowPath, `${lbugShadowPath}.wal`, `${lbugShadowPath}.lock` ];
  for (const f of shadowFiles) {
    try { await fs.rm(f, { recursive: true, force: true }); } catch {}
  }

  // BUILD IN SHADOW
  await initLbug(lbugShadowPath); 
```

- [ ] **Step 3: Implement Atomic Swap after completion**

```typescript
// Around line 340, before closeLbug()
    // ── Phase 4: Atomic Swap ──────────────────────────────────────────
    progress('lbug', 98, 'Finalizing index (Atomic Swap)...');
    await closeLbug();

    const liveFiles = [lbugPath, `${lbugPath}.wal`, `${lbugPath}.lock` ];
    const shadowFiles = [lbugShadowPath, `${lbugShadowPath}.wal` ];

    // 1. Remove old live files
    for (const f of liveFiles) {
      try { await fs.rm(f, { force: true, recursive: true }); } catch {}
    }

    // 2. Move shadow to live
    if (await fs.stat(lbugShadowPath).catch(() => null)) {
      await fs.rename(lbugShadowPath, lbugPath);
    }
    if (await fs.stat(`${lbugShadowPath}.wal`).catch(() => null)) {
      await fs.rename(`${lbugShadowPath}.wal`, `${lbugPath}.wal`);
    }

    log(`[analyze] Successfully swapped shadow index to live for ${projectName}`);
```

- [ ] **Step 4: Commit Shadow Indexing change**

```bash
git add gitnexus/src/core/run-analyze.ts
git commit -m "feat(analyze): implement shadow indexing and atomic swap for outage resilience"
```

---

### Task 3: Verification

- [ ] **Step 1: Redeploy to remote server**

Run: `bash mcp_proxy_docker/remote_deploy.sh`

- [ ] **Step 2: Monitor logs for successful indexing**

Run: `ssh ji99@10.1.14.177 "docker logs -f gitnexus-mcp-proxy"`
Confirm: "Loading into LadybugDB (Shadow Build)..." and "Successfully swapped shadow index" appear.
