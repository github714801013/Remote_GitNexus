# Git Author Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitNexus MCP tool that maps a repository-relative file line range to Git blame authors and commit history.

**Architecture:** Reuse LocalBackend repo resolution and code_snippet path-safety rules. Execute git through `execFileSync('git', args, ...)` with argument arrays, parse `git blame --line-porcelain` for current line ownership, and parse `git log -L` for bounded history.

**Tech Stack:** TypeScript, Node.js, MCP tool definitions, Vitest, Git CLI.

---

### Task 1: Add RED Tests

**Files:**
- Modify: `gitnexus/test/unit/tools.test.ts`
- Create: `gitnexus/test/unit/mcp/git-author-trace.test.ts`

- [ ] Add schema tests asserting `git_author_trace` exists, requires `filePath`, `startLine`, and `endLine`, and exposes optional `repo`, `includeHistory`, and `maxCommits`.
- [ ] Add LocalBackend behavior tests using a temporary git repository with two commits by different authors.
- [ ] Run targeted tests and confirm they fail because the tool does not exist yet.

### Task 2: Implement MCP Tool

**Files:**
- Modify: `gitnexus/src/mcp/tools.ts`
- Modify: `gitnexus/src/mcp/local/local-backend.ts`
- Modify: `gitnexus/src/mcp/server.ts`

- [ ] Add the `git_author_trace` tool definition near `code_snippet`.
- [ ] Add `callTool` dispatch to `LocalBackend`.
- [ ] Implement line range validation, repository path validation, blame parsing, and optional history parsing.
- [ ] Add a next-step hint in the MCP server for the new tool.

### Task 3: Verify and Audit

**Files:**
- Modify: `docs/superpowers/TODO.md`

- [ ] Run targeted unit tests.
- [ ] Run TypeScript typecheck.
- [ ] Run `detect_changes` or record the user-approved direct-search fallback if GitNexus indexing remains unavailable.
- [ ] Update TODO with completed checks, modified file list, and any risk notes.
