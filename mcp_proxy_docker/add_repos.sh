#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/.env}"
if [ -f "${ENV_FILE}" ]; then
    set -a
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    set +a
fi

: "${REPOS_BASE_DIR:?REPOS_BASE_DIR environment variable is required}"
: "${REPO_CLONE_SPECS:?REPO_CLONE_SPECS environment variable is required}"

IFS=';' read -r -a repo_specs <<< "${REPO_CLONE_SPECS}"
for spec in "${repo_specs[@]}"; do
    [ -n "${spec}" ] || continue
    repo_url="${spec%%|*}"
    repo_rel="${spec#*|}"
    if [ "${repo_url}" = "${repo_rel}" ] || [ -z "${repo_url}" ] || [ -z "${repo_rel}" ]; then
        echo "跳过无效仓库配置: ${spec}"
        continue
    fi

    repo_dir="${REPOS_BASE_DIR}/${repo_rel}"
    mkdir -p "$(dirname "${repo_dir}")"
    if [ ! -d "${repo_dir}" ]; then
        echo "正在克隆 ${repo_rel}..."
        git clone "${repo_url}" "${repo_dir}" || echo "克隆 ${repo_rel} 失败"
    fi
done

echo "--- 触发新项目的增量索引 ---"
for spec in "${repo_specs[@]}"; do
    [ -n "${spec}" ] || continue
    repo_rel="${spec#*|}"
    if [ "${spec}" = "${repo_rel}" ] || [ -z "${repo_rel}" ]; then
        continue
    fi
    project_dir="/projects/${repo_rel}"
    echo "正在触发索引: ${project_dir}"
    docker exec -d gitnexus-mcp-proxy bash -c "
        git config --global --add safe.directory '*'
        echo '--------------------------------------------------------' > /proc/1/fd/1
        echo '手动触发索引: ${project_dir}' > /proc/1/fd/1
        /usr/bin/node /app/gitnexus/dist/cli/index.js analyze '${project_dir}' --embeddings --force > /proc/1/fd/1 2>&1
    "
done
