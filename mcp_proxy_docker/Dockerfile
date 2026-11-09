# 使用 Ubuntu 24.04 (Noble) 作为基底，它包含最新的 libstdc++ (支持 GLIBCXX_3.4.32)
FROM ubuntu:24.04

# 配置代理与镜像 (加速构建) - 如需代理，请通过 build-arg 或宿主环境传递

# 避免交互式提示
ENV DEBIAN_FRONTEND=noninteractive
ARG NODE_VERSION=22.22.1

# 1. 配置 Ubuntu 镜像并安装核心工具与 Node.js 22
RUN if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then \
        sed -i 's/archive.ubuntu.com/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/ubuntu.sources && \
        sed -i 's/security.ubuntu.com/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/ubuntu.sources; \
    fi && \
    if [ -f /etc/apt/sources.list ]; then \
        sed -i 's/archive.ubuntu.com/mirrors.ustc.edu.cn/g' /etc/apt/sources.list && \
        sed -i 's/security.ubuntu.com/mirrors.ustc.edu.cn/g' /etc/apt/sources.list; \
    fi && \
    apt-get update -y && apt-get install -y --fix-missing \
    curl \
    ca-certificates \
    cron \
    tzdata \
    xz-utils \
    python3 \
    git \
    ruby-full \
    ruby-dev \
    rsync \
    build-essential \
    libgomp1 \
    util-linux \
    ripgrep \
    && gem install cocoapods -N \
    && git config --global user.email "gitnexus@example.com" \
    && git config --global user.name "GitNexus Builder" \
    && git config --global --add safe.directory "*" \
    && ln -s /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) node_arch="x64" ;; \
      arm64) node_arch="arm64" ;; \
      *) echo "Unsupported architecture: ${arch}" >&2; exit 1 ;; \
    esac; \
    node_dist="node-v${NODE_VERSION}-linux-${node_arch}"; \
    node_tar="/tmp/${node_dist}.tar.xz"; \
    for base_url in "https://npmmirror.com/mirrors/node" "https://nodejs.org/dist"; do \
      if curl -fSL --retry 5 --retry-delay 3 --connect-timeout 20 \
        "${base_url}/v${NODE_VERSION}/${node_dist}.tar.xz" -o "${node_tar}"; then \
        break; \
      fi; \
    done; \
    test -s "${node_tar}"; \
    tar -xJf "${node_tar}" -C /usr/local --strip-components=1; \
    rm -f "${node_tar}"; \
    node --version; \
    npm --version

# 设置 npm 全局配置以增加稳定性
RUN npm config set fetch-retry-maxtimeout 600000 && \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000
ENV PATH="/app/gitnexus/node_modules/.bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
ENV HF_HOME="/app/models"
ENV XENOVA_CACHE="/app/models"
ENV HF_ENDPOINT="https://hf-mirror.com"

WORKDIR /app

# 安装 serve（用于托管前端）
RUN npm install -g serve --registry=http://registry.npmmirror.com

# 3. 复制项目文件
COPY gitnexus ./gitnexus
COPY gitnexus-shared ./gitnexus-shared
COPY gitnexus-web ./gitnexus-web

# 4. 构建 gitnexus-shared
WORKDIR /app/gitnexus-shared
RUN npm install --registry=http://registry.npmmirror.com --no-audit --no-fund --ignore-scripts && \
    ./node_modules/.bin/tsc

# 5. 构建 GitNexus (Backend)
WORKDIR /app/gitnexus
# 注意：不再执行 node_modules/onnxruntime-node/script/install，省去数GB的 GPU 依赖下载
RUN npm install --registry=http://registry.npmmirror.com --no-audit --no-fund --ignore-scripts && \
    npm rebuild @ladybugdb/core && \
    npx tsc && \
    mkdir -p dist/_shared dist/gitnexus/vendor && \
    cp -r /app/gitnexus-shared/src/* dist/_shared/ && \
    cp package.json dist/gitnexus/ && \
    cp -r vendor/* dist/gitnexus/vendor/ && \
    chmod +x dist/cli/index.js

# 6. 构建 GitNexus Web (Frontend)
WORKDIR /app/gitnexus-web
ARG VITE_BACKEND_URL
ENV VITE_BACKEND_URL=${VITE_BACKEND_URL}
RUN npm install --registry=http://registry.npmmirror.com --no-audit --no-fund --ignore-scripts --legacy-peer-deps && \
    npx vite build

# 7. Setup the Web UI proxy
WORKDIR /app/mcp_proxy
COPY ./mcp_proxy_docker/proxy.js ./proxy.js

# Expose ports
EXPOSE 1347 1350

# Entrypoint script
COPY ./mcp_proxy_docker/entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
