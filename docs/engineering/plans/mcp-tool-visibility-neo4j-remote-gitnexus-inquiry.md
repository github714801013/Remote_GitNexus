# GitNexus 调研记录：Neo4j 远程 MCP 工具可见性收敛

- 任务：`mcp-tool-visibility-neo4j-remote`
- 调研范围：当前工作区
- 证据来源：`local_search`
- 证据权威：`non_gitnexus`
- 限制：远程 GitNexus `query` 返回 `Repository is not available through this MCP server`，因此本记录不能证明完整调用图、完整消费者或运行时行为。

## 结论

现有 `GITNEXUS_MCP_READ_ONLY=1` 已同时实现 MCP 的发现层隐藏与 dispatch 层拒绝，并清理 group 资源/路由；远程 Neo4j Docker 部署尚未启用它。当前没有“按工具名称 allowlist”的环境变量，也没有将 `GITNEXUS_STORAGE_BACKEND=neo4j` 与工具面自动收敛绑定的机制。

## 关键证据

- `gitnexus/src/mcp/tools.ts:84-962`：`GITNEXUS_TOOLS` 静态注册 19 个工具；`:33-52` 定义只读/查询/破坏性 annotations。
- `gitnexus/src/mcp/server.ts:191-205`：`tools/list` 从注册表出发并应用只读与仓库策略；`:207-240`：调用前执行只读检查后再 dispatch。
- `gitnexus/src/mcp/read-only-policy.ts:4-20`：只读允许集合；`:22-51`：解析 `GITNEXUS_MCP_READ_ONLY` 并在 dispatch 前拒绝隐藏工具；`:53-119`：隐藏 group 资源、描述与 schema 中的不可用能力。
- `gitnexus/src/mcp/repository-policy.ts:10-12,416-527`：已有仓库 allowlist/default repo 与工具/资源作用域约束，但不是工具 allowlist。
- `gitnexus/src/core/neo4j/config.ts:15-19`：仅以 `GITNEXUS_STORAGE_BACKEND=neo4j` 判断 Neo4j 后端；静态证据未显示其参与工具发现过滤。
- `gitnexus/src/server/api.ts:1157-1160` 和 `src/server/mcp-http.ts:16-36`：`gitnexus serve` 会暴露内嵌 `/api/mcp`。
- `gitnexus/src/mcp/http-transport.ts:477-620`：独立 HTTP MCP 暴露 `/mcp`、`/sse` 与 `/messages`。
- `mcp_proxy_docker/docker-compose.yml:147-219`：远程 Neo4j 服务设置 `GITNEXUS_STORAGE_BACKEND=neo4j`，但未设置 `GITNEXUS_MCP_READ_ONLY` 或仓库范围变量。
- `mcp_proxy_docker/entrypoint.sh:41-58`：部署启动 `gitnexus serve`；外部 `/api/mcp` 由 `mcp_proxy_docker/proxy.js:20-48` 转发。
- 回归测试：`gitnexus/test/unit/mcp-read-only.test.ts:63-249`、`mcp-repository-policy.test.ts:463-560`、`mcp-http-transport.test.ts:17-332`、`server.test.ts:69-269`、`tools.test.ts:23-45`。

## 待明确的产品边界

1. 保留集合是否仅为核心查询（`list_repos`、`query`、`context`、`impact`、`trace`），还是保留全部既有只读工具？
2. 收敛是否同时要求 discovery 隐藏与直接调用拒绝？现有 read-only 策略两者均覆盖。
3. 作用范围是远程 Docker 的内嵌 `/api/mcp`，还是同时包括独立 HTTP 与 stdio MCP？
4. 触发条件是远程 Neo4j 部署显式配置，还是所有 `GITNEXUS_STORAGE_BACKEND=neo4j` 运行时自动生效？
5. 是否同时配置仓库 allowlist/default repo，禁用 group 路由？

## 建议

在没有精确工具白名单前，优先在远程 Docker compose 显式启用 `GITNEXUS_MCP_READ_ONLY=1`，复用已有完整的 discovery + dispatch 防线，而不将 Neo4j 存储选择隐式耦合到全局 MCP 权限模型。若要精确收敛工具集合，则需要新增独立配置并在 `server.ts` 的发现和调用两处强制执行，同时扩展相应单测。
