#!/bin/bash
# 本地打包 vLLM 镜像和 Qwen3-Embedding-4B 模型，并部署到 10.1.14.158。

set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-10.1.14.158}"
REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_PATH="${REMOTE_PATH:-/home/ji99/Project/qwen3_embedding_vllm}"
VLLM_IMAGE="${VLLM_IMAGE:-vllm/vllm-openai:latest}"
BUILDX_BUILDER="${BUILDX_BUILDER:-qwen3-vllm-deploy-builder}"
BUILDKIT_IMAGE="${BUILDKIT_IMAGE:-moby/buildkit:buildx-stable-1}"
COMPOSE_FILE="docker-compose-qwen3-embedding.yml"
SERVICE_NAME="qwen3-embedding-vllm"
HOST_PORT="${QWEN3_EMBEDDING_PORT:-954}"
MODEL_SOURCE_DIR="${MODEL_SOURCE_DIR:-mcp_proxy_docker/models/Qwen3-Embedding-4B}"
MODEL_REMOTE_DIR="${REMOTE_PATH}/models/Qwen3-Embedding-4B"
if command -v cygpath >/dev/null 2>&1 && [ -n "${TEMP:-}" ]; then
    TEMP_ROOT=$(cygpath -u "${TEMP}")
else
    TEMP_ROOT="${TMPDIR:-${TEMP:-${TMP:-.}}}"
fi
WORK_DIR=$(mktemp -d "${TEMP_ROOT%/}/gitnexus-vllm-qwen3.XXXXXX")
BUILDKIT_DOCKERFILE="${WORK_DIR}/Dockerfile.vllm"
IMAGE_TAR="${WORK_DIR}/vllm-openai.tar"
IMAGE_TAR_GZ="${IMAGE_TAR}.gz"

cleanup() {
    rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

if [ ! -d "${MODEL_SOURCE_DIR}" ]; then
    echo "缺少本地模型目录: ${MODEL_SOURCE_DIR}"
    echo "请先把 Qwen3-Embedding-4B 模型放到该目录，或通过 MODEL_SOURCE_DIR 指定实际路径。"
    exit 1
fi

echo "=== 步骤 1: 使用 moby/buildkit 构建并打包 vLLM 镜像 ==="
cat > "${BUILDKIT_DOCKERFILE}" <<'DOCKERFILE'
ARG VLLM_IMAGE
FROM ${VLLM_IMAGE}
DOCKERFILE

if ! docker buildx inspect "${BUILDX_BUILDER}" >/dev/null 2>&1; then
    docker buildx create \
        --name "${BUILDX_BUILDER}" \
        --driver docker-container \
        --driver-opt "image=${BUILDKIT_IMAGE}" \
        --use
fi
docker buildx inspect "${BUILDX_BUILDER}" --bootstrap >/dev/null

MSYS_NO_PATHCONV=1 docker buildx build \
    --builder "${BUILDX_BUILDER}" \
    --pull \
    --build-arg "VLLM_IMAGE=${VLLM_IMAGE}" \
    -t "${VLLM_IMAGE}" \
    -f "${BUILDKIT_DOCKERFILE}" \
    --output "type=docker,dest=${IMAGE_TAR}" \
    "${WORK_DIR}"
gzip -f "${IMAGE_TAR}"

echo ""
echo "=== 步骤 2: 准备远端目录 ==="
ssh "${REMOTE_USER}@${REMOTE_HOST}" -T << EOF
    set -e
    mkdir -p "${REMOTE_PATH}/models"
EOF

echo ""
echo "=== 步骤 3: 上传镜像、Compose 文件和模型 ==="
scp "${IMAGE_TAR_GZ}" "mcp_proxy_docker/${COMPOSE_FILE}" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/"
if command -v rsync >/dev/null 2>&1; then
    rsync -avz --delete --progress "${MODEL_SOURCE_DIR}/" "${REMOTE_USER}@${REMOTE_HOST}:${MODEL_REMOTE_DIR}/"
else
    ssh "${REMOTE_USER}@${REMOTE_HOST}" "mkdir -p '${MODEL_REMOTE_DIR}'"
    scp -r "${MODEL_SOURCE_DIR}/." "${REMOTE_USER}@${REMOTE_HOST}:${MODEL_REMOTE_DIR}/"
fi

echo ""
echo "=== 步骤 4: 远端加载镜像并启动服务 ==="
ssh "${REMOTE_USER}@${REMOTE_HOST}" -T << EOF
    set -e
    cd "${REMOTE_PATH}"

    echo "加载 vLLM 镜像..."
    gunzip -c "$(basename "${IMAGE_TAR_GZ}")" | docker load
    rm -f "$(basename "${IMAGE_TAR_GZ}")"

    echo "启动 Qwen3 Embedding vLLM 服务..."
    VLLM_IMAGE="${VLLM_IMAGE}" \
    QWEN3_EMBEDDING_PORT="${HOST_PORT}" \
    docker compose -f "${COMPOSE_FILE}" up -d

    echo "--- 容器状态 ---"
    docker ps --filter "name=${SERVICE_NAME}"
EOF

echo ""
echo "=== 步骤 5: 验证 Embedding 接口 ==="
ssh "${REMOTE_USER}@${REMOTE_HOST}" -T << EOF
    set -e
    python3 - <<'PY'
import json
import time
import urllib.error
import urllib.request

url = "http://127.0.0.1:${HOST_PORT}/v1/embeddings"
payload = {
    "model": "qwen3-embedding-4b",
    "input": ["GitNexus embedding health check"]
}
data = json.dumps(payload).encode("utf-8")
request = urllib.request.Request(
    url,
    data=data,
    headers={"Content-Type": "application/json"},
    method="POST",
)

last_error = None
for _ in range(60):
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = json.loads(response.read().decode("utf-8"))
            embedding = body["data"][0]["embedding"]
            print(f"embedding_dimension={len(embedding)}")
            print(f"model={body.get('model')}")
            raise SystemExit(0)
    except (urllib.error.URLError, TimeoutError, KeyError, IndexError, json.JSONDecodeError) as exc:
        last_error = exc
        time.sleep(10)

raise SystemExit(f"Embedding 接口验证失败: {last_error}")
PY
EOF

echo ""
echo "部署完成: http://${REMOTE_HOST}:${HOST_PORT}/v1/embeddings"
