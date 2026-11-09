# 需求澄清记录：远程 Neo4j MCP 工具可见性

## 已确认决策

1. 远程 Neo4j 服务复用现有 `GITNEXUS_MCP_READ_ONLY=1` 策略，不新增按工具名称的白名单机制。
2. 该策略仅由 `mcp_proxy_docker` 的远程 Neo4j Docker 部署显式启用。
3. 不将 `GITNEXUS_STORAGE_BACKEND=neo4j` 与 MCP 可见性全局耦合；本地 stdio MCP、独立 HTTP MCP、CLI 和常规 Web/API 运行方式保持现状。

## 预期结果

远程部署通过内嵌 `/api/mcp` 暴露的 MCP 工具面仅保留既有只读查询能力；`cypher`、`rename`、group 工具、group 路由等由已有策略在发现层隐藏且在调用层拒绝。实现优先修改部署配置，并以现有 MCP 只读策略单测作为行为基线。

## 证据

- 用户在本任务的需求澄清中选择“复用只读模式（推荐）”。
- 用户确认“仅远程 Docker（推荐）”作用范围。
- `docs/engineering/plans/mcp-tool-visibility-neo4j-remote-gitnexus-inquiry.md` 记录现有只读策略和部署路径的静态证据。
