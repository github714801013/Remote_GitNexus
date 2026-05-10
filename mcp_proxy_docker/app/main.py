from fastapi import FastAPI, Request, HTTPException
import os
import asyncio
import logging
import json
import portalocker
import shutil
import subprocess
import tempfile
from typing import Optional
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
from .executor import DEFER_ANALYZE, _embedding_phase_is_running, run_analyze

# Configure Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("mcp_proxy.main")

def get_projects_root():
    # 宿主机环境通过环境变量注入此路径
    return os.getenv("PROJECTS_ROOT", "/projects")

def get_indexing_concurrency():
    return int(os.getenv("INDEXING_CONCURRENCY", "1"))

def get_deferred_retry_delay():
    return int(os.getenv("GITNEXUS_DEFERRED_ANALYZE_RETRY_SECONDS", "60"))

def _touch_zoekt_trigger(repo_path: str) -> None:
    """在仓库目录写入触发文件，通知 zoekt-indexserver 对该仓库重新索引。"""
    trigger = os.path.join(repo_path, ".zoekt-reindex")
    try:
        with open(trigger, "w") as f:
            f.write("")
    except Exception as e:
        logger.debug(f"Failed to write zoekt trigger for {repo_path}: {e}")

_concurrency = get_indexing_concurrency()
_analyze_semaphore: asyncio.Semaphore = asyncio.Semaphore(_concurrency)
_queued_repo_paths: set[str] = set()
_pending_repo_requests: dict[str, tuple[str, Optional[str], Optional[str]]] = {}
_queued_repo_lock = asyncio.Lock()

async def queue_guarded_analyze(repo_path: str, clone_url: Optional[str] = None, branch: Optional[str] = None) -> bool:
    repo_key = os.path.abspath(repo_path)
    async with _queued_repo_lock:
        if repo_key in _queued_repo_paths:
            _pending_repo_requests[repo_key] = (repo_path, clone_url, branch)
            logger.info(f"Deferring duplicate indexing task for {repo_path}")
            return False
        _queued_repo_paths.add(repo_key)

    asyncio.create_task(run_guarded_analyze(repo_path, clone_url, branch, repo_key))
    return True

async def run_pending_analyze_after_embedding(
    repo_path: str,
    repo_key: str,
    poll_seconds: int,
):
    poll_interval = max(poll_seconds, 0.01)
    while _embedding_phase_is_running(repo_path):
        await asyncio.sleep(poll_interval)

    async with _queued_repo_lock:
        pending = _pending_repo_requests.pop(repo_key, None)
        if pending is None:
            _queued_repo_paths.discard(repo_key)
            return

    logger.info(f"Scheduling deferred indexing task for {pending[0]} after embedding phase completed")
    asyncio.create_task(run_guarded_analyze(pending[0], pending[1], pending[2], repo_key))

async def run_guarded_analyze(repo_path: str, clone_url: Optional[str] = None, branch: Optional[str] = None, repo_key: Optional[str] = None):
    """
    Runs indexing with concurrency control.
    """
    repo_key = repo_key or os.path.abspath(repo_path)
    result = None
    try:
        async with _analyze_semaphore:
            logger.info(f"Indexing task started for {repo_path}")
            result = await asyncio.to_thread(run_analyze, repo_path, clone_url, branch)
            logger.info(f"Indexing task finished for {repo_path}")
            # GitNexus 索引完成后通知 zoekt-indexserver 对该仓库重新索引
            if result != DEFER_ANALYZE:
                _touch_zoekt_trigger(repo_path)
    except Exception:
        logger.error(f"Indexing task failed for {repo_path}", exc_info=True)
    finally:
        async with _queued_repo_lock:
            pending = _pending_repo_requests.pop(repo_key, None)
            if result == DEFER_ANALYZE:
                if pending is None:
                    pending = (repo_path, clone_url, branch)
                _pending_repo_requests[repo_key] = pending
                poll_seconds = get_deferred_retry_delay()
                logger.info(f"Queued deferred indexing task for {pending[0]} until embedding phase completes")
                asyncio.create_task(run_pending_analyze_after_embedding(repo_path, repo_key, poll_seconds))
            elif pending:
                if _embedding_phase_is_running(repo_path):
                    _pending_repo_requests[repo_key] = pending
                    poll_seconds = get_deferred_retry_delay()
                    logger.info(f"Queued deferred indexing task for {pending[0]} until embedding phase completes")
                    asyncio.create_task(run_pending_analyze_after_embedding(repo_path, repo_key, poll_seconds))
                else:
                    logger.info(f"Scheduling deferred indexing task for {repo_path}")
                    asyncio.create_task(run_guarded_analyze(pending[0], pending[1], pending[2], repo_key))
            else:
                _queued_repo_paths.discard(repo_key)

async def warmup_extensions():
    """
    Runs a minimal analyze command to ensure LadybugDB extensions are installed.
    This prevents race conditions when multiple parallel processes try to install them.
    """
    logger.info("Warming up LadybugDB extensions (serial)...")
    warmup_dir = tempfile.mkdtemp(prefix="gitnexus-lbug-warmup-")
    warmup_db = os.path.join(warmup_dir, "lbug")
    script = """
const lbug = await import('@ladybugdb/core');
const dbPath = process.argv[1];
let db;
let conn;
try {
  db = new lbug.default.Database(dbPath);
  conn = new lbug.default.Connection(db);
  await conn.query('INSTALL fts');
  await conn.query('LOAD EXTENSION fts');
  await conn.query('INSTALL vector');
  await conn.query('LOAD EXTENSION vector');
  await conn.query('RETURN 1');
  process.exit(0);
} catch (err) {
  console.error(err?.message ?? String(err));
  process.exit(2);
} finally {
  if (conn) await conn.close().catch(() => {});
  if (db) await db.close().catch(() => {});
}
"""
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            ["node", "--input-type=module", "-e", script, warmup_db],
            cwd="/app/gitnexus",
            capture_output=True,
            text=True,
            check=False,
            env=os.environ.copy(),
        )
        if result.returncode == 0:
            logger.info("LadybugDB extensions warmed up successfully.")
            return True
        logger.warning(
            "LadybugDB extension warmup failed: %s",
            (result.stderr or result.stdout or "").strip(),
        )
    except Exception as e:
        logger.error(f"Warmup failed: {e}")
    finally:
        shutil.rmtree(warmup_dir, ignore_errors=True)
    return False

@asynccontextmanager
async def lifespan(app: FastAPI):
    projects_root = get_projects_root()
    logger.info(f"Starting GitNexus MCP Proxy in Trust Mode with PROJECTS_ROOT={projects_root}")
    await warmup_extensions()

    # 启动时读取 repos.json，对每个 repo 触发后台索引
    repos_file = os.path.join(projects_root, "repos.json")
    if os.path.exists(repos_file):
        try:
            with open(repos_file, 'r') as f:
                repos_list = json.load(f)
            logger.info(f"Auto-indexing {len(repos_list)} repos from repos.json on startup...")
            
            # 1. Warmup: Index the first repo serially to install extensions and initialize registry
            if repos_list:
                first = repos_list[0]
                repo_path = os.path.join(projects_root, first.get("full_name"))
                repo_key = os.path.abspath(repo_path)
                async with _queued_repo_lock:
                    _queued_repo_paths.add(repo_key)
                logger.info(f"Warmup indexing for {repo_path}")
                try:
                    await asyncio.to_thread(run_analyze, repo_path, first.get("clone_url"), first.get("branch"))
                finally:
                    async with _queued_repo_lock:
                        pending = _pending_repo_requests.pop(repo_key, None)
                        if pending:
                            asyncio.create_task(run_guarded_analyze(pending[0], pending[1], pending[2], repo_key))
                        else:
                            _queued_repo_paths.discard(repo_key)

            # 2. Schedule the rest with concurrency control
            for repo in repos_list[1:]:
                full_name = repo.get("full_name")
                clone_url = repo.get("clone_url")
                branch = repo.get("branch")
                if full_name:
                    repo_path = os.path.join(projects_root, full_name)
                    queued = await queue_guarded_analyze(repo_path, clone_url, branch)
                    if queued:
                        logger.info(f"Scheduling startup index: {full_name} -> {repo_path}")
        except Exception as e:
            logger.error(f"Failed to auto-index repos on startup: {e}")
    else:
        logger.info(f"No repos.json found at {repos_file}, skipping auto-index.")

    yield
    logger.info("GitNexus MCP Proxy stopping.")

app = FastAPI(title="GitNexus MCP Proxy Service (Webhook Optimized)", lifespan=lifespan)

@app.get("/health")
def health_check():
    return {"status": "ok", "projects_root": get_projects_root()}

@app.post("/webhook/gitea")
async def gitea_webhook(
    request: Request
):
    """
    Webhook handler for Gitea.
    - Clones repository if missing locally.
    - Updates and analyzes repository if already exists.
    """
    projects_root = get_projects_root()
    
    try:
        payload = await request.json()
    except Exception:
        logger.error("Failed to decode JSON payload")
        raise HTTPException(status_code=400, detail="Invalid JSON")

    # Extract repo info
    try:
        repo_data = payload.get("repository", {})
        repo_name = repo_data.get("full_name")  # e.g., "user/repo"
        clone_url = repo_data.get("clone_url")  # SSH or HTTP URL
        
        # Extract branch from ref (e.g., refs/heads/main -> main)
        ref = payload.get("ref", "")
        branch = ref.replace("refs/heads/", "") if ref.startswith("refs/heads/") else None
        
        if not repo_name:
            logger.error("Repository full_name not found in payload")
            raise HTTPException(status_code=400, detail="Repository full_name missing")
        
        # Determine local path (mapping repo_name directly to subfolders in projects_root)
        repo_path = os.path.join(projects_root, repo_name)
        
        # Update the dynamic repos.json config file to keep track of Webhook-added repos and branches
        repos_file = os.path.join(projects_root, "repos.json")
        
        try:
            # 使用文件锁防止并发写入冲突
            with portalocker.Lock(repos_file, 'a+', timeout=10) as f:
                f.seek(0)
                try:
                    content = f.read()
                    repos_list = json.loads(content) if content else []
                except Exception:
                    repos_list = []
                
                found = False
                for r in repos_list:
                    if r.get("full_name") == repo_name:
                        if clone_url:
                            r["clone_url"] = clone_url
                        if branch:
                            r["branch"] = branch
                        found = True
                        break
                
                if not found:
                    repos_list.append({
                        "full_name": repo_name,
                        "clone_url": clone_url,
                        "branch": branch or "master"
                    })
                
                f.seek(0)
                f.truncate()
                json.dump(repos_list, f, indent=2, ensure_ascii=False)
        except Exception as e:
            logger.error(f"Failed to update repos.json concurrently: {e}")

        logger.info(f"Queueing indexing for {repo_name} (URL: {clone_url}, Branch: {branch}) at {repo_path}")
        queued = await queue_guarded_analyze(repo_path, clone_url, branch)
        status = "accepted" if queued else "deferred"

        return {"status": status, "repository": repo_name, "path": repo_path}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error processing webhook: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
