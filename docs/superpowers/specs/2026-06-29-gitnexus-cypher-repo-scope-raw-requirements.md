# GitNexus Cypher Repo Scope 原始需求

Last Updated: 2026-06-29

## 用户原始输入

用户反馈：`nc-segments` 图里存在大量非本仓前缀：`oa-stock-service`、`oa-finance-service`、`orginfo-service`、`oa-office-service`、`oa-order-service` 等，要求查看其他项目是否也存在这个问题，并分析如何修复这个 bug。

随后用户确认：“开始修复”。

## 已确认现象

- `cypher(repo="nc-segments")` 在 Neo4j raw Cypher 查询未显式过滤 `repoId` 时，会返回多个仓库的数据。
- `cypher(repo="oa-order")` 存在相同行为。
- 显式添加 `n.repoId = '<repo>'` 后，各仓路径前缀恢复为本仓内容。

## 本次范围

- 修改范围：`gitnexus/` TypeScript/Node 的 MCP/CLI raw Cypher 与 HTTP raw Cypher 查询入口。
- 不涉及：索引写入、Neo4j schema、Java/Spring、本地测试 Controller、前端页面契约。

## 验收标准

- MCP/CLI raw Cypher 在 Neo4j 模式下传入 `repo` 时，查询必须显式使用 `repoId` 或 `$repoId`，否则返回明确错误。
- 使用 `$repoId` 的查询应收到 `{ repoId: <repo name> }` 参数。
- HTTP `/api/query` 在 Neo4j 模式下应把当前请求解析到的仓库名传给查询层，并遵守同样规则。
- 未指定仓库的全局 raw Cypher 查询能力保持可用。
