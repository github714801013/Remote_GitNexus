#!/bin/bash
set -e

# Link the node_modules so that absolute imports work as expected
mkdir -p /app/gitnexus/node_modules
ln -sfn /app/gitnexus-shared /app/gitnexus/node_modules/gitnexus-shared

# Add compiled JS path to PATH for gitnexus command
export PATH="/app/gitnexus/dist/gitnexus/src/cli:$PATH"
export HF_HOME="${HF_HOME:-/app/models}"
export GITNEXUS_EMBEDDING_MODEL="${GITNEXUS_EMBEDDING_MODEL:-Xenova/bge-small-zh-v1.5}"
export GITNEXUS_EMBEDDING_DIMS="${GITNEXUS_EMBEDDING_DIMS:-512}"
export GITNEXUS_FTS_STEMMER="${GITNEXUS_FTS_STEMMER:-none}"
export GITNEXUS_REMOTE_DEPLOY="${GITNEXUS_REMOTE_DEPLOY:-true}"
export GITNEXUS_EMBEDDING_DEVICE="${GITNEXUS_EMBEDDING_DEVICE:-cuda}"
export GITNEXUS_EMBEDDING_BATCH_SIZE="${GITNEXUS_EMBEDDING_BATCH_SIZE:-1}"
# 持久化 registry 到挂载卷，避免容器重启后丢失索引注册信息
export GITNEXUS_HOME="${GITNEXUS_HOME:-/root/.gitnexus}"
mkdir -p "$GITNEXUS_HOME"
export TZ="${TZ:-Asia/Shanghai}"
if [ -f "/usr/share/zoneinfo/$TZ" ]; then
  ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
  echo "$TZ" >/etc/timezone
fi

# Daily index health check. The endpoint only enqueues stale/missing-vector repos.
cat >/etc/cron.d/gitnexus-index-health-check <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 22 * * * root curl -fsS -X POST http://127.0.0.1:1347/api/index-health-check >> /proc/1/fd/1 2>> /proc/1/fd/2
EOF
chmod 0644 /etc/cron.d/gitnexus-index-health-check
cron

# Ensure CUDA and cuDNN libraries are found.
# NOTE: /usr/local/cuda-12/compat is intentionally excluded — it contains
# libcuda.so.560.35.05 which conflicts with the host driver (590+) mounted
# by the NVIDIA container runtime, causing CUDA error 803 (driver mismatch).
export LD_LIBRARY_PATH="/usr/local/cuda-12/targets/x86_64-linux/lib:/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH"

# Route analyze subprocess embedding calls through the serve process (port 1347).
# This ensures only one CUDA session exists (in the serve process), preventing
# concurrent GPU memory allocation from multiple analyze subprocesses.
export GITNEXUS_EMBEDDING_URL="${GITNEXUS_EMBEDDING_URL:-http://localhost:1347/v1}"

# Change directory to the proxy app
cd /app/mcp_proxy

# 1. Start the GitNexus HTTP API (UI Backend) on port 1347.
echo "Starting GitNexus HTTP API (UI Backend) on port 1347..."
node /app/gitnexus/dist/gitnexus/src/cli/index.js serve --port 1347 --host 0.0.0.0 &
serve_pid=$!

# 2. Start the GitNexus Web UI on port 1350
echo "Starting GitNexus Web UI on port 1350 (via proxy)..."
# Use a custom proxy script to route /api to the backend and serve static files for others
node /app/mcp_proxy/proxy.js &
proxy_pid=$!

trap 'service cron stop >/dev/null 2>&1 || true; kill -TERM "$serve_pid" "$proxy_pid" 2>/dev/null || true; wait 2>/dev/null || true' TERM INT

set +e
wait -n "$serve_pid" "$proxy_pid"
exit_code=$?
set -e
echo "A GitNexus service exited with code ${exit_code}; stopping remaining services."
service cron stop >/dev/null 2>&1 || true
kill -TERM "$serve_pid" "$proxy_pid" 2>/dev/null || true
wait 2>/dev/null || true
exit "$exit_code"
