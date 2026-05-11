# Embedding Scheduling Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the background embedding phase is rescheduled when `embedding.pid` is stale or points at the MCP proxy process instead of an embedding worker.

**Architecture:** Keep the fix inside `mcp_proxy_docker/app/executor.py`. The scheduler will create a pending marker, start the worker, then overwrite the marker with the child PID so future checks inspect the real embedding process.

**Tech Stack:** Python, pytest, Docker MCP proxy deployment.

---

### Task 1: Regression Test

**Files:**
- Modify: `mcp_proxy_docker/tests/test_executor.py`

- [ ] Add a test where `embedding.pid` contains the current process PID and assert `_try_mark_embedding_phase` still returns `True`.
- [ ] Run `python -m pytest mcp_proxy_docker/tests/test_executor.py -q` and confirm the new test fails before implementation.

### Task 2: Scheduler Fix

**Files:**
- Modify: `mcp_proxy_docker/app/executor.py`

- [ ] Add a helper that treats only known embedding worker commands as an active embedding process.
- [ ] Write the child `Popen.pid` into `embedding.pid` after the worker starts.
- [ ] Remove the marker if `Popen` fails.

### Task 3: Verification

**Commands:**
- `python -m pytest mcp_proxy_docker/tests -q`
- `python -m py_compile mcp_proxy_docker/app/main.py mcp_proxy_docker/app/executor.py mcp_proxy_docker/app/embedding_phase.py`
- `bash -n mcp_proxy_docker/remote_deploy.sh`
- `git diff --check`
