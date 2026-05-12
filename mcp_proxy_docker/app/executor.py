import subprocess
import os
import json
import portalocker
import logging
import shutil
import sys
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger("mcp_proxy.executor")

GITNEXUS_BIN = "/app/gitnexus/dist/gitnexus/src/cli/index.js"
EMBEDDING_LOG_FILE = "/app/mcp_proxy/logs/gitnexus_embedding_phase.log"
DEFER_ANALYZE = "deferred"
DEFAULT_ANALYZE_MAX_OLD_SPACE_MB = "16384"

def _with_node_heap_env(env: dict) -> dict:
    node_options = env.get("NODE_OPTIONS", "")
    if "--max-old-space-size" in node_options:
        return env

    heap_mb = env.get("GITNEXUS_ANALYZE_MAX_OLD_SPACE_MB", DEFAULT_ANALYZE_MAX_OLD_SPACE_MB)
    env["NODE_OPTIONS"] = f"{node_options} --max-old-space-size={heap_mb}".strip()
    return env

def _is_lock_error(message: str) -> bool:
    return "Could not set lock" in message or "lock" in message.lower()

def _probe_lbug(lbug_path: str, env: dict) -> tuple[bool, str]:
    if not os.path.exists(lbug_path):
        return False, "lbug file does not exist"

    script = """
const lbug = await import('@ladybugdb/core');
const dbPath = process.argv[1];
let db;
let conn;
try {
  db = new lbug.default.Database(dbPath, 0, false, true);
  conn = new lbug.default.Connection(db);
  const queryResult = await conn.query('RETURN 1');
  const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
  await result.getAll();
  process.exit(0);
} catch (err) {
  console.error(err?.message ?? String(err));
  process.exit(2);
} finally {
  if (conn) await conn.close().catch(() => {});
  if (db) await db.close().catch(() => {});
}
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script, lbug_path],
        cwd="/app/gitnexus",
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    return result.returncode == 0, (result.stderr or result.stdout or "").strip()

def _restore_latest_backup(repo_path: str, env: dict) -> tuple[bool, str]:
    gitnexus_dir = os.path.join(repo_path, ".gitnexus")
    latest_dir = os.path.join(gitnexus_dir, "backups", "latest")
    backup_lbug = os.path.join(latest_dir, "lbug")
    backup_meta = os.path.join(latest_dir, "meta.json")
    lbug_path = os.path.join(gitnexus_dir, "lbug")
    meta_path = os.path.join(gitnexus_dir, "meta.json")

    backup_ok, backup_msg = _probe_lbug(backup_lbug, env)
    if not backup_ok:
        return False, f"latest backup is not usable: {backup_msg}"

    lbug_tmp = lbug_path + ".restore.tmp"
    wal_tmp = lbug_path + ".wal.restore.tmp"
    meta_tmp = meta_path + ".restore.tmp"

    shutil.copy2(backup_lbug, lbug_tmp)
    backup_wal = os.path.join(latest_dir, "lbug.wal")
    has_wal = os.path.exists(backup_wal)
    if has_wal:
        shutil.copy2(backup_wal, wal_tmp)
    has_meta = os.path.exists(backup_meta)
    if has_meta:
        shutil.copy2(backup_meta, meta_tmp)

    for p in [lbug_path + ".lock", lbug_path + ".wal"]:
        try:
            os.remove(p)
        except FileNotFoundError:
            pass

    os.replace(lbug_tmp, lbug_path)
    if has_wal:
        os.replace(wal_tmp, lbug_path + ".wal")
    if has_meta:
        os.replace(meta_tmp, meta_path)
    return True, "restored latest backup"

def _needs_embedding_phase(meta: dict) -> bool:
    return int(meta.get("stats", {}).get("embeddings") or 0) <= 0

def _process_is_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False

def _process_is_embedding_phase(pid: int) -> bool:
    cmdline_path = os.path.join("/proc", str(pid), "cmdline")
    try:
        with open(cmdline_path, "rb") as f:
            cmdline = f.read().replace(b"\x00", b" ").decode("utf-8", errors="ignore")
    except OSError:
        return False
    return "app.embedding_phase" in cmdline or "--embeddings" in cmdline

def _embedding_pid_path(repo_path: str) -> str:
    return os.path.join(repo_path, ".gitnexus", "embedding.pid")

def _write_embedding_pid(repo_path: str, pid: int):
    with open(_embedding_pid_path(repo_path), "w", encoding="utf-8") as f:
        f.write(str(pid))

def _remove_embedding_pid(repo_path: str):
    try:
        os.remove(_embedding_pid_path(repo_path))
    except FileNotFoundError:
        pass

def _embedding_phase_is_running(repo_path: str) -> bool:
    try:
        with open(_embedding_pid_path(repo_path), "r", encoding="utf-8") as f:
            pid = int((f.read() or "0").strip())
    except Exception:
        pid = 0
    if pid > 0 and _process_is_running(pid) and _process_is_embedding_phase(pid):
        return True

    lock_file = os.path.join(repo_path, ".gitnexus_embedding.lock")
    try:
        with portalocker.Lock(lock_file, timeout=0):
            return False
    except portalocker.exceptions.AlreadyLocked:
        return True
    except Exception:
        return False

def _try_mark_embedding_phase(repo_path: str) -> bool:
    marker_dir = os.path.join(repo_path, ".gitnexus")
    os.makedirs(marker_dir, exist_ok=True)
    pid_path = _embedding_pid_path(repo_path)
    try:
        fd = os.open(pid_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        try:
            with open(pid_path, "r", encoding="utf-8") as f:
                pid = int((f.read() or "0").strip())
            if pid > 0 and _process_is_running(pid) and _process_is_embedding_phase(pid):
                return False
        except Exception:
            pass
        try:
            os.remove(pid_path)
            fd = os.open(pid_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            return False

    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(str(os.getpid()))
    return True

def _start_embedding_phase(repo_path: str, gitnexus_bin: str, env: dict):
    if os.getenv("GITNEXUS_DISABLE_ASYNC_EMBEDDINGS", "").lower() in {"1", "true", "yes"}:
        logger.info(f"Async embedding phase disabled for {repo_path}")
        return
    if not _try_mark_embedding_phase(repo_path):
        logger.info(f"Embedding phase already scheduled for {repo_path}")
        return

    log_path = os.getenv("GITNEXUS_EMBEDDING_PHASE_LOG", EMBEDDING_LOG_FILE)
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    log_file = open(log_path, "a", encoding="utf-8")
    logger.info(f"Starting background embedding phase for {repo_path}; log={log_path}")
    try:
        process = subprocess.Popen(
            [sys.executable, "-m", "app.embedding_phase", repo_path, gitnexus_bin],
            cwd="/app/mcp_proxy",
            stdout=log_file,
            stderr=subprocess.STDOUT,
            close_fds=True,
            env=env,
        )
        _write_embedding_pid(repo_path, process.pid)
    except Exception:
        _remove_embedding_pid(repo_path)
        log_file.close()
        raise

def get_authenticated_url(url: str) -> str:
    """
    Injects GITEA_TOKEN into the Git URL if available.
    """
    token = os.getenv("GITEA_TOKEN")
    if not token or not url.startswith("http"):
        return url
    
    parsed = urlparse(url)
    # Reconstruct URL with token: https://token@domain/path
    return f"{parsed.scheme}://{token}@{parsed.netloc}{parsed.path}"

def run_analyze(repo_path: str, git_url: Optional[str] = None, branch: Optional[str] = None):
    """
    Ensures the repository exists (clone if not), pulls latest changes, 
    and runs 'npx gitnexus analyze'.
    """
    
    # 1. Handle cloning if repository doesn't exist
    if not os.path.isdir(repo_path):
        # Webhook mapping is projects_root/group/repo
        # Let's check if it exists at projects_root/repo instead (flat structure fallback)
        projects_root = os.getenv("PROJECTS_ROOT", "/projects")
        repo_basename = os.path.basename(repo_path)
        flat_path = os.path.join(projects_root, repo_basename)
        
        if os.path.isdir(flat_path):
            logger.info(f"Found existing repository at flat path: {flat_path}")
            repo_path = flat_path
        elif not git_url:
            logger.error(f"Repository path {repo_path} does not exist and no git_url provided for cloning.")
            return False
        else:
            try:
                auth_url = get_authenticated_url(git_url)
                logger.info(f"Cloning {git_url} (authenticated) into {repo_path}")
                # Ensure parent directory exists
                os.makedirs(os.path.dirname(repo_path), exist_ok=True)
                
                clone_cmd = ["git", "clone", "--depth", "1"]
                if branch:
                    clone_cmd.extend(["-b", branch])
                clone_cmd.extend([auth_url, repo_path])

                # Use --depth 1 for faster initial clone in webhook
                result = subprocess.run(
                    clone_cmd,
                    capture_output=True,
                    text=True,
                    check=False
                )
                if result.returncode != 0:
                    logger.error(f"Failed to clone repository. Exit code: {result.returncode}")
                    if result.stderr:
                        # Clean stderr to avoid leaking token
                        clean_err = result.stderr.replace(os.getenv("GITEA_TOKEN", "MISSING_TOKEN"), "****")
                        logger.error(f"Clone error: {clean_err}")
                    return False
            except Exception as e:
                logger.error(f"Error during cloning: {str(e)}")
                return False

    # 2. Proceed with Update and Analyze using a per-repo Lock
    # Use per-repo lock to prevent concurrent analysis of the same repository
    lock_file = os.path.join(repo_path, ".gitnexus_analyze.lock")

    try:
        # Acquire per-repo lock
        with portalocker.Lock(lock_file, timeout=60):
            if _embedding_phase_is_running(repo_path):
                logger.info(f"Deferring analyze for {repo_path}: embedding phase is already running")
                return DEFER_ANALYZE

            # Ensure the latest code is pulled before indexing
            logger.info(f"Updating latest changes for {repo_path}")            
            # Use authenticated URL for pull as well
            if git_url:
                auth_url = get_authenticated_url(git_url)
                subprocess.run(
                    ["git", "remote", "set-url", "origin", auth_url],
                    cwd=repo_path,
                    capture_output=True,
                    check=False
                )

            # Force fetch and overwrite local code to ensure consistency
            subprocess.run(["git", "fetch", "origin", "--depth", "1"], cwd=repo_path, capture_output=True, check=False)
            
            if not branch:
                # Try to detect default branch if not provided
                res = subprocess.run(["git", "remote", "show", "origin"], cwd=repo_path, capture_output=True, text=True, check=False)
                for line in res.stdout.splitlines():
                    if "HEAD branch" in line:
                        branch = line.split(":")[-1].strip()
                        break
                if not branch:
                    branch = "main" # Final fallback

            logger.info(f"Forcing remote overwrite to origin/{branch}")
            subprocess.run(["git", "checkout", "-f", branch], cwd=repo_path, capture_output=True, check=False)
            subprocess.run(["git", "reset", "--hard", f"origin/{branch}"], cwd=repo_path, capture_output=True, check=False)
            subprocess.run(["git", "clean", "-fd", "-e", ".gitnexus", "-e", ".gitnexus/"], cwd=repo_path, capture_output=True, check=False)

            # Use absolute path to gitnexus binary inside container
            gitnexus_bin = GITNEXUS_BIN

            # EXPLICITLY pass proxy env vars to ensure fetch works in container runtime
            env = _with_node_heap_env(os.environ.copy())
            if os.getenv("https_proxy"):
                env["HTTPS_PROXY"] = os.getenv("https_proxy")
            if os.getenv("http_proxy"):
                env["HTTP_PROXY"] = os.getenv("http_proxy")

            # Use HF mirror to bypass proxy timeout issues for transformers.js
            env["HF_ENDPOINT"] = os.getenv("HF_ENDPOINT", "https://hf-mirror.com")

            # Explicitly set embedding model for Chinese support (gte-Qwen2-1.5B-instruct ONNX)
            env["GITNEXUS_EMBEDDING_MODEL"] = os.getenv("GITNEXUS_EMBEDDING_MODEL", "twright8/gte-Qwen2-1.5B-instruct-onnx-fp16")
            env["GITNEXUS_EMBEDDING_DIMS"] = os.getenv("GITNEXUS_EMBEDDING_DIMS", "1536")
            env["GITNEXUS_USE_FLASH_ATTENTION"] = os.getenv("GITNEXUS_USE_FLASH_ATTENTION", "true")
            env["GITNEXUS_FTS_STEMMER"] = os.getenv("GITNEXUS_FTS_STEMMER", "none")
            env["GITNEXUS_EMBEDDING_LIMIT"] = os.getenv("GITNEXUS_EMBEDDING_LIMIT", "500000")
            env["GITNEXUS_REMOTE_DEPLOY"] = os.getenv("GITNEXUS_REMOTE_DEPLOY", "true")
            env["GITNEXUS_EMBEDDING_BATCH_SIZE"] = os.getenv("GITNEXUS_EMBEDDING_BATCH_SIZE", "1")
            env["GITNEXUS_ALLOW_REMOTE_MODELS"] = os.getenv("GITNEXUS_ALLOW_REMOTE_MODELS", "false")

            if os.getenv("GITNEXUS_EMBEDDING_DEVICE"):
                env["GITNEXUS_EMBEDDING_DEVICE"] = os.getenv("GITNEXUS_EMBEDDING_DEVICE")

            # Use dedicated indexing vLLM instance if provided, else fallback to main URL
            index_url = os.getenv("GITNEXUS_INDEX_EMBEDDING_URL", os.getenv("GITNEXUS_EMBEDDING_URL"))
            if index_url:
                env["GITNEXUS_EMBEDDING_URL"] = index_url

            if os.getenv("GITNEXUS_EMBEDDING_API_KEY"):                env["GITNEXUS_EMBEDDING_API_KEY"] = os.getenv("GITNEXUS_EMBEDDING_API_KEY")

            # Skip analyze if already indexed at the current commit
            current_commit_res = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=repo_path, capture_output=True, text=True, check=False
            )
            current_commit = current_commit_res.stdout.strip()
            meta_path = os.path.join(repo_path, ".gitnexus", "meta.json")
            lbug_path = os.path.join(repo_path, ".gitnexus", "lbug")
            shadow_wal = os.path.join(repo_path, ".gitnexus", "lbug.shadow.wal")
            if current_commit and os.path.exists(meta_path):
                try:
                    with open(meta_path, "r") as f:
                        meta = json.load(f)
                    if meta.get("lastCommit") == current_commit:
                        if _needs_embedding_phase(meta) and _embedding_phase_is_running(repo_path):
                            logger.info(f"Deferring analyze for {repo_path}: embedding phase is already running")
                            return DEFER_ANALYZE
                        # 真实打开 LadybugDB 做探针，避免 224KB 这类坏文件被 size>0 误判为可用。
                        lbug_ok, lbug_error = _probe_lbug(lbug_path, env)
                        shadow_leftover = os.path.exists(shadow_wal)
                        if lbug_ok and not shadow_leftover:
                            logger.info(f"Skipping analyze for {repo_path}: already indexed at {current_commit[:8]}")
                            register_result = subprocess.run(
                                ["node", gitnexus_bin, "index", repo_path],
                                capture_output=True,
                                text=True,
                                check=False,
                                env=env,
                            )
                            if register_result.returncode != 0:
                                logger.warning(f"Failed to refresh registry for {repo_path}; re-indexing.")
                            else:
                                if _needs_embedding_phase(meta):
                                    _start_embedding_phase(repo_path, gitnexus_bin, env)
                                return True
                        else:
                            logger.warning(f"Index integrity check failed for {repo_path}: lbug_ok={lbug_ok}, shadow_leftover={shadow_leftover}, error={lbug_error}.")
                            if not shadow_leftover and not (lbug_error and _is_lock_error(lbug_error)):
                                restored, restore_msg = _restore_latest_backup(repo_path, env)
                                if restored:
                                    logger.warning(f"Restored latest GitNexus index backup for {repo_path}; refreshing registry.")
                                    register_result = subprocess.run(
                                        ["node", gitnexus_bin, "index", repo_path],
                                        capture_output=True,
                                        text=True,
                                        check=False,
                                        env=env,
                                    )
                                    if register_result.returncode == 0:
                                        return True
                                    logger.warning(f"Backup restore registry refresh failed for {repo_path}; re-indexing.")
                                else:
                                    logger.warning(f"Backup restore skipped for {repo_path}: {restore_msg}. Re-indexing.")
                            else:
                                logger.warning(f"Index looks busy for {repo_path}; re-indexing without backup restore.")
                except Exception:
                    pass

            logger.info(f"Starting GitNexus structure analyze for {repo_path}")
            # 先生成结构索引并 swap 到 live，保证项目尽快可查询；向量化在结构成功后后台补齐。
            result = subprocess.run(
                ["node", gitnexus_bin, "analyze", repo_path],
                capture_output=True,
                text=True,
                check=False,
                env=env
            )
            
            if result.stdout:
                logger.info(f"Analyze output: {result.stdout}")
            if result.stderr:
                logger.info(f"Analyze error/warning output: {result.stderr}")
            
            if result.returncode == 0:
                logger.info(f"Successfully indexed structure for {repo_path}")
                # Fix permissions so non-root processes (serve/mcp) can write FTS indexes
                gitnexus_dir = os.path.join(repo_path, ".gitnexus")
                if os.path.isdir(gitnexus_dir):
                    subprocess.run(["chmod", "-R", "a+rw", gitnexus_dir], check=False)
                    subprocess.run(["chmod", "a+rwx", gitnexus_dir], check=False)
                _start_embedding_phase(repo_path, gitnexus_bin, env)
                return True
            else:
                logger.error(f"Failed to index {repo_path}. Exit code: {result.returncode}")
                combined_output = f"{result.stdout}\n{result.stderr}"
                if "not a valid Lbug database file" in combined_output or "Unable to open database" in combined_output or _is_lock_error(combined_output):
                    restored, restore_msg = _restore_latest_backup(repo_path, env)
                    if restored:
                        logger.warning(f"Restored latest GitNexus index backup for {repo_path} after analyze failure.")
                    else:
                        logger.warning(f"Backup restore after analyze failure skipped for {repo_path}: {restore_msg}")
                return False
                
    except portalocker.exceptions.AlreadyLocked:
        logger.warning(f"Analyze for {repo_path} is already in progress.")
        return False
    except Exception as e:
        logger.error(f"Error during indexing for {repo_path}: {str(e)}")
        return False
    finally:
        # Cleanup lock file
        if os.path.exists(lock_file):
            try:
                os.remove(lock_file)
            except:
                pass
