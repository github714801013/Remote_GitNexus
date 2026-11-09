# GitNexus 调研记录：Wiki 支持 Neo4j 后端

**task_id:** wiki-neo4j-backend
**stage:** gitnexus-inquiry
**scope:** current_workspace

## 1. GitNexus 主查询记录

| 项 | 值 |
|---|---|
| tool | `mcp__remote_gitnexus__query` |
| repo | GitNexus |
| search_query | `Wiki generator graph queries LadybugDB data source initWikiDb` |
| 结果 | 失败：`Repository is not available through this MCP server.` |

远端 MCP 服务器未授权当前工作区仓库（符合 `local_fallback_only_when` 的 `repository_unindexed` / `authorization_unavailable`），按节点 evidence_policy 降级为受限本地检索；以下证据标记 `source=local_search、authority=non_gitnexus`。

## 2. 本地检索证据

### 2.1 Wiki 数据源当前 100% 依赖本地 LadybugDB

`gitnexus/src/core/wiki/graph-queries.ts`：

- 第 8 行仅导入 `initLbug / executeQuery / closeLbug / touchRepo / pinRepo`（`../lbug/pool-adapter.js`）。
- `initWikiDb(lbugPath)`（第 57-59 行）→ `initLbug(REPO_ID, lbugPath)`，必须打开本地 lbug 文件。
- 全部图查询（`getFilesWithExports`、`getAllFiles`、`getIntraModuleCallEdges`、`getInterModuleCallEdges`、进程查询等）经 `executeQuery(REPO_ID, cypher)` 执行，Cypher 基于 `File`/`CodeRelation {type: '...'}` 图结构。

`gitnexus/src/core/wiki/generator.ts`：

- 第 300 行 `await initWikiDb(this.lbugPath)` 硬接线本地库路径。

`gitnexus/src/server/wiki-queue.ts`（本会话新增）：

- 构造 `WikiGenerator` 时无条件传 `path.join(task.storagePath, 'lbug')`。

### 2.2 Neo4j 部署下本地 lbug 不存在（远端实证）

远端 10.1.14.158 部署日志（Neo4j 后端）：

```text
LadybugDB not found at /projects/OA_CSharp/saasoanew/.gitnexus/lbug
    at initWikiDb (graph-queries.js:28)
    at WikiGenerator.run (generator.js:187)
    at WikiQueue.run (wiki-queue.js:168)
code=generation_failed
```

即 analyze 成功后自动入队 Wiki，但生成在初始化数据源时即失败。

### 2.3 Neo4j 侧可复用查询 seam 已存在

- `gitnexus/src/core/neo4j/driver.ts:27`：`withNeo4jSession` 是既有 Neo4j 查询 seam。
- `read-adapter.ts`、`embedding-adapter.ts`、`graph-loader.ts`、`write-adapter.ts` 均复用该 seam。
- `gitnexus/src/server/api.ts` 多处按 `isNeo4jBackendEnabled()` 分支（Neo4j 模式下不触碰本地 lbug）。
- Neo4j 后端图 schema 与 Wiki 查询目标一致：同为 `CodeRelation {type: ...}` 边结构（`graph-loader.ts` 写入、`search.ts` 读取）。

## 3. 结论（可行性）

**可以走 Neo4j。** 最小路径：

1. 为 Wiki 图数据源引入后端适配：本地 LadybugDB（现状）与 Neo4j（`withNeo4jSession`）双实现；Wiki 查询语句两端 schema 兼容，需按仓库 `repoId` 过滤（Neo4j 节点带 `repoId` 属性）。
2. `WikiGenerator` 按 `isNeo4jBackendEnabled()` 选择数据源：Neo4j 模式跳过 `initLbug`，`touch/pin` 保活映射为 no-op 或会话级保活。
3. `WikiQueue` 在 Neo4j 模式下不再传本地 lbug 路径。

## 4. 未确认项

- 全部 9 个图查询函数（含 processes 两步查询）的 Neo4j 等价实现工作量未逐项核对。
- `touchWikiDb/pinWikiDb` 的池保活语义在 Neo4j 会话下如何映射未确认。
- 本记录基于受限本地检索，不能证明完整调用链与影响范围；实现阶段应补充 impact 分析（本地 GitNexus 图当前仍因 LadybugDB 42/41 版本不兼容不可用）。
