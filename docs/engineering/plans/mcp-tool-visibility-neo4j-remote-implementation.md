# 实施记录：远程 Neo4j MCP 只读工具面

## 修改

- `mcp_proxy_docker/docker-compose.yml`：为 proxy 服务增加可配置的 `GITNEXUS_MCP_READ_ONLY` 环境变量，默认值为 `0`，本地直接运行保持现有完整工具面。
- `mcp_proxy_docker/remote_deploy.sh`：生成远端 `.env` 时写入 `GITNEXUS_MCP_READ_ONLY=1`；启动远端 Compose 时以内联赋值再次强制为 `1`，避免远端既有环境变量覆盖该部署安全边界。

## 验证

- `bash -n mcp_proxy_docker/remote_deploy.sh`：通过。
- `docker compose config`：基础 Compose 无变量时渲染为 `GITNEXUS_MCP_READ_ONLY: "0"`；模拟远端内联覆盖时渲染为 `"1"`。
- `cd gitnexus && npx vitest run test/unit/mcp-read-only.test.ts`：24 项通过。
- `cd gitnexus && npx tsc --noEmit`：通过。
- 代码审查两轮：先后发现并修复共享 Compose 污染本地运行方式、远端环境变量优先级覆盖问题；最终复核无阻断问题。
