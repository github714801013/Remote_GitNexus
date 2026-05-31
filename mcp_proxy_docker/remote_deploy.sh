#!/bin/bash
# GitNexus 远程部署脚本 (Bash 版)
# 功能：本地构建 -> 压缩导出 -> SCP 传输 -> 远程加载 -> 容器启动

set -e

# 配置参数
REMOTE_HOST="10.1.14.177"
REMOTE_USER="ji99"
REMOTE_PATH="/home/ji99/Project/mcp_gitnexus_server"
REGISTRY_URL="harbor.saas.ch999.cn:1088/common"
IMAGE_NAME="gitnexus-mcp-proxy"
TAR_FILE="gitnexus_noble_deploy.tar.gz"
RAW_TAR_FILE="${TAR_FILE%.gz}"
BUILDX_BUILDER="gitnexus-deploy-builder"
: "${gitnexus_gitea_token:?gitnexus_gitea_token environment variable is required}"

# 自动修复 Windows Bash 下的 Docker 路径问题
DOCKER_HELPER_PATH=$(where.exe docker-credential-desktop.exe 2>/dev/null | head -n 1)
if [ -n "$DOCKER_HELPER_PATH" ]; then
    DOCKER_BIN_DIR=$(dirname "$DOCKER_HELPER_PATH" | sed 's/\\/\//g' | sed 's/C:/\/c/' | sed 's/c:/\/c/')
    export PATH="$PATH:$DOCKER_BIN_DIR"
fi

echo "=== 步骤 1: 本地构建镜像 (使用缓存) ==="
version=$(git rev-parse --short HEAD 2>/dev/null || echo "latest")
full_image_tag="${REGISTRY_URL}/${IMAGE_NAME}:${version}"

export DOCKER_BUILDKIT=1
rm -f "${RAW_TAR_FILE}" "${TAR_FILE}"
if ! docker buildx inspect "${BUILDX_BUILDER}" >/dev/null 2>&1; then
    docker buildx create --name "${BUILDX_BUILDER}" --driver docker-container --use
fi
docker buildx inspect "${BUILDX_BUILDER}" --bootstrap >/dev/null
MSYS_NO_PATHCONV=1 docker buildx build \
    --builder "${BUILDX_BUILDER}" \
    -t "${full_image_tag}" \
    -t "${IMAGE_NAME}:latest" \
    -f mcp_proxy_docker/Dockerfile \
    --build-arg VITE_BACKEND_URL=/ \
    --output "type=docker,dest=${RAW_TAR_FILE}" \
    .

echo ""
echo "=== 步骤 2: 压缩镜像归档 ==="
gzip -f "${RAW_TAR_FILE}"

echo ""
echo "=== 步骤 3: 传输镜像和配置到远端 ==="
ssh "${REMOTE_USER}@${REMOTE_HOST}" -T << EOF
    set -e
    mkdir -p "${REMOTE_PATH}/models" /home/ji99/.gitnexus /home/ji99/.lbdb
    if [ -f "${REMOTE_PATH}/repos.json" ]; then cp "${REMOTE_PATH}/repos.json" "${REMOTE_PATH}/repos.json.bak"; fi
    if [ -f /home/ji99/gitnexus/repos.json ]; then cp /home/ji99/gitnexus/repos.json /home/ji99/gitnexus/repos.json.bak; fi
    if [ -f /home/ji99/.gitnexus/registry.json ]; then cp /home/ji99/.gitnexus/registry.json "${REMOTE_PATH}/registry.json.bak"; fi

    echo "Neo4j 模式不再备份 LadybugDB 索引 meta.json"
EOF
scp "${TAR_FILE}" mcp_proxy_docker/auto_verify.py repos.json mcp_proxy_docker/docker-compose-vllm.yml mcp_proxy_docker/docker-compose.yml "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/"

echo ""
echo "=== 步骤 4: 远程部署与启动 ==="
ssh "${REMOTE_USER}@${REMOTE_HOST}" -T << EOF
    set -e
    cd "${REMOTE_PATH}"

    echo "正在加载镜像..."
    gunzip -c "${TAR_FILE}" | docker load

    echo "清理传输文件..."
    rm "${TAR_FILE}"

    echo "启动辅助引擎 (vLLM)..."
    docker compose -f docker-compose-vllm.yml up -d

    echo "停止并清理旧的独立容器 (如有)..."
    docker stop -t 30 "${IMAGE_NAME}" 2>/dev/null || true
    docker rm "${IMAGE_NAME}" 2>/dev/null || true

    echo "启动 GitNexus + Zoekt (docker compose)..."
    GITEA_TOKEN="${gitnexus_gitea_token}" \
    GITNEXUS_EMBEDDING_BATCH_SIZE="${GITNEXUS_EMBEDDING_BATCH_SIZE:-1}" \
    docker compose -f docker-compose.yml up -d

    echo "--- 执行自动验证 ---"
    python3 auto_verify.py
EOF

echo ""
echo "=== 步骤 5: 部署完成，查看日志 ==="
ssh "${REMOTE_USER}@${REMOTE_HOST}" "docker logs --tail 20 ${IMAGE_NAME}"

# 本地清理
rm -f "${TAR_FILE}"
