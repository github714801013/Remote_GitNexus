#!/bin/bash
# 本地构建 Docker 镜像并通过 SSH 隧道进行“伪本地”拉取
# 解决 1. 导出压缩包慢 2. 远端不支持非 HTTPS 仓库 的问题

set -e

REMOTE_HOST="10.1.14.177"
REMOTE_USER="ji99"
REMOTE_PATH="/home/ji99/Project/mcp_gitnexus_server"
REGISTRY_HOST="harbor.saas.ch999.cn"
REGISTRY_PORT="1088"
REGISTRY_URL="${REGISTRY_HOST}:${REGISTRY_PORT}/common"
IMAGE_NAME="gitnexus-mcp-proxy"

echo "=== 步骤 1: 获取版本号 ==="
version=$(git rev-parse --short HEAD 2>/dev/null || echo "v1.0.0")
full_image_name="${REGISTRY_URL}/${IMAGE_NAME}:${version}"
# 注意：远端拉取时使用 localhost 绕过 HTTPS 检查
local_pull_name="localhost:${REGISTRY_PORT}/common/${IMAGE_NAME}:${version}"

echo "=== 步骤 2: 本地构建 Docker 镜像 ==="
export DOCKER_BUILDKIT=1
docker build --network=host --progress=plain \
    --build-arg VITE_BACKEND_URL="http://${REMOTE_HOST}:1347" \
    -t "${full_image_name}" \
    -f mcp_proxy_docker/Dockerfile .

echo ""
echo "=== 步骤 3: 推送镜像到私有仓库 ==="
docker push "${full_image_name}"

echo ""
echo "=== 步骤 4: 上传配置文件和模型到远端 ==="
# 仅上传 models 目录中不存在的文件 (增量上传)
ssh "${REMOTE_USER}@${REMOTE_HOST}" "mkdir -p ${REMOTE_PATH}/models"
scp mcp_proxy_docker/auto_verify.py repos.json mcp_proxy_docker/docker-compose-vllm.yml "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/"
echo "正在上传模型文件 (可能较大，请稍候)..."
# 使用 rsync 增量同步模型 (如果可用)，否则回退到 scp
if command -v rsync >/dev/null 2>&1; then
    rsync -avz --progress mcp_proxy_docker/models/ "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/models/"
else
    scp -r mcp_proxy_docker/models/* "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/models/"
fi

echo ""
echo "=== 步骤 5: 通过 SSH 隧道远端拉取并启动 ==="
# 使用 -R 将远端的 1088 端口转发到本地可以访问的 harbor 地址
# 这样远端 docker pull localhost:1088 就会流向私有仓库
ssh -o StrictHostKeyChecking=no -R "${REGISTRY_PORT}:${REGISTRY_HOST}:${REGISTRY_PORT}" "${REMOTE_USER}@${REMOTE_HOST}" -T << EOF
    set -e
    cd "${REMOTE_PATH}"

    echo "正在通过隧道拉取镜像: ${local_pull_name}"
    docker pull "${local_pull_name}"

    # 重新打标为原始名称，方便管理
    docker tag "${local_pull_name}" "${full_image_name}"
    docker tag "${full_image_name}" "${REGISTRY_URL}/${IMAGE_NAME}:latest"

    echo "停止并移除旧容器..."
    docker stop "${IMAGE_NAME}" 2>/dev/null || true
    docker rm "${IMAGE_NAME}" 2>/dev/null || true

    echo "启动 vLLM 双实例搜索与索引引擎 (按需下载模型权重)..."
    docker compose -f docker-compose-vllm.yml up -d

    echo "启动新容器 (代理服务 & 挂载模型目录)..."
    docker run -d --name "${IMAGE_NAME}" \
        --gpus all \
        -p 1347:1347 -p 1350:1350 \
        -v /home/ji99/gitnexus:/projects \
        -v "${REMOTE_PATH}/models:/app/models" \
        --restart always \
        -e GITEA_TOKEN="401a8a2a8339719a3a313eece19bc1d312f3531b" \
        -e GITNEXUS_EMBEDDING_URL="http://${REMOTE_HOST}:8001/v1" \
        -e GITNEXUS_INDEX_EMBEDDING_URL="http://${REMOTE_HOST}:8002/v1" \
        -e GITNEXUS_EMBEDDING_MODEL="Alibaba-NLP/gte-Qwen2-1.5B-instruct" \
        -e GITNEXUS_EMBEDDING_DIMS="1536" \
        "${full_image_name}"
EOF

echo ""
echo "=== 步骤 6: 验证运行状态 ==="
ssh -o StrictHostKeyChecking=no "${REMOTE_USER}@${REMOTE_HOST}" -T << 'VERIFY'
    echo "--- 检查 GPU 内存占用 ---"
    nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits

    echo ""
    echo "--- 检查索引进程 ---"
    docker exec gitnexus-mcp-proxy ps aux | grep -E "analyze|node" | grep -v grep

    echo ""
    echo "--- 查看启动日志 (GPU 相关) ---"
    docker logs gitnexus-mcp-proxy 2>&1 | grep -iE "cuda|gpu|device|embedding|onnx|error" | head -20
VERIFY

echo ""
echo "部署完成！使用了 SSH 隧道拉取模式。"
