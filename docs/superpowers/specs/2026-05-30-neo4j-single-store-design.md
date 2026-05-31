# Neo4j 单库替代设计

## 背景

当前 GitNexus 的图索引、向量索引和跨仓库搜索建立在 LadybugDB 单文件库之上。该路径在高并发查询、后台向量写入和多仓库 fan-out 场景下容易被单文件锁、只读连接池和 native 崩溃风险限制。用户已确认将目标从 pgvector 改为 Neo4j，由一个服务化数据库同时承载图搜索和向量搜索。

本设计替代旧的 `pgvector` compose-only 方案。旧方案只提供 PostgreSQL + pgvector 容器，不改变 TypeScript 查询链路；新方案要求新增 Neo4j 存储适配层，并逐步把 LadybugDB 的图、向量、FTS 查询能力迁移到 Neo4j。

## 目标

- 使用 Neo4j 作为 GitNexus 的主索引库，替代 LadybugDB 单文件库。
- 同一数据库同时支持图遍历、语义向量搜索、跨仓库搜索和高并发读写。
- 保持 MCP/CLI 对外工具语义不变：`query`、`context`、`impact`、`cypher`、`group` 等入口不改参数契约。
- 尽量复用现有 ingestion 输出、schema 常量、embedding pipeline、RRF 合并、repo registry 和 group mode 路由。
- 保留最小回退边界：迁移期间允许通过环境变量禁用 Neo4j 写入或搜索，但最终目标是 Neo4j 默认启用。

## 非目标

- 不在本阶段兼容 pgvector。
- 不引入 Neo4j Enterprise 专属能力；默认使用 Community 镜像和 `LIST<FLOAT>` embedding 属性。
- 不重写语言解析、作用域解析、调用关系推断和 process 识别逻辑。
- 不改变 MCP 工具返回结构，除非实现层无法避免且先补充兼容说明。

## 关键假设

- Neo4j Docker 镜像使用官方 Community Edition，计划 pin 到 `neo4j:2026.04.0`，部署前通过 `docker pull neo4j:2026.04.0` 验证 tag 存在。
- Neo4j vector index 可对节点属性建立 HNSW 向量索引；当前 embedding 维度继续使用 `GITNEXUS_EMBEDDING_DIMS`，默认 512。
- Neo4j Community Edition 可使用 `LIST<FLOAT>` 属性保存 embedding；不依赖 Enterprise 的原生 `VECTOR` 类型。
- GitNexus 现有 Cypher 大部分可迁移，但 LadybugDB 专用语法、FTS 和 vector procedure 必须改写。

## 数据模型

Neo4j 使用属性图模型，不再按 LadybugDB 每种节点类型建单独 node table。每个代码对象创建一个节点：

- 标签：保留原节点类型标签，例如 `File`、`Function`、`Class`、`Method`、`Route`、`Tool`、`Process`。
- 通用属性：`repoId`、`id`、`name`、`filePath`、`startLine`、`endLine`、`content`、`description`。
- 唯一键：`(repoId, id)`，避免多仓库同名节点冲突。
- 关系类型：优先使用真实 Neo4j relationship type，例如 `CALLS`、`IMPORTS`、`CONTAINS`、`STEP_IN_PROCESS`。
- 兼容属性：关系保留 `type`、`confidence`、`reason`、`step`，兼容现有查询和排序逻辑。
- 向量 chunk：使用 `CodeEmbedding` 节点保存 chunk 级 embedding，属性包括 `repoId`、`id`、`nodeId`、`chunkIndex`、`startLine`、`endLine`、`embedding`、`contentHash`。
- chunk 关系：`(:CodeEmbedding)-[:EMBEDS]->(:CodeNode)` 或等价关系，便于向量结果回查源符号。

## 索引

初始化 Neo4j 时创建以下约束和索引：

- 每个代码标签的 `repoId + id` 唯一约束。
- `File(repoId, filePath)` 普通索引。
- 常用符号标签的 `repoId + name` 普通索引。
- `CodeEmbedding(repoId, id)` 唯一约束。
- `CodeEmbedding(embedding)` vector index，维度取 `GITNEXUS_EMBEDDING_DIMS`，相似度使用 `cosine`。
- 文本搜索先保留现有 Zoekt/BM25 入口；Neo4j full-text index 作为后续增强，不阻塞第一版替换。

## 写入路径

`gitnexus analyze` 继续执行现有解析和 pipeline，只在持久化层切换到 Neo4j：

1. 初始化 Neo4j driver 和约束。
2. 清理当前 `repoId` 的旧节点、旧关系和旧 embedding。
3. 批量 upsert 节点。
4. 批量 upsert 关系。
5. embedding pipeline 生成 chunk 后批量 upsert `CodeEmbedding`。
6. 等待 vector index 进入 `ONLINE`，再更新 `.gitnexus/meta.json` 和全局 registry。

写入必须使用参数化 Cypher 和事务批处理，禁止拼接用户输入到 Cypher。

## 查询路径

MCP `LocalBackend` 的入口保持不变：

- `query`：BM25/Zoekt/vector 继续 RRF 合并；vector 改查 Neo4j `CodeEmbedding` vector index。
- `semanticSearch`：生成 query embedding 后查 Neo4j vector index，再通过 `nodeId` 回查符号节点。
- `context`：按 `repoId + name/id` 查询符号、上下游关系、文件和 process。
- `impact`：使用 Neo4j 关系遍历替代 LadybugDB relationship table 查询。
- `cypher`：连接 Neo4j 执行只读 Cypher，保留写操作拦截。
- `group`：跨仓库搜索优先使用单次 Neo4j 查询按 `repoId IN [...]` 过滤；需要保持 member path 和 service filter 语义。

## 部署

`mcp_proxy_docker/docker-compose.yml` 移除 pgvector 服务，新增 Neo4j 服务：

- 镜像：`neo4j:2026.04.0`。
- 持久化 volume：`neo4j-data`、`neo4j-logs`。
- 环境变量：`NEO4J_AUTH`、内存配置、插件禁用默认项。
- GitNexus 主服务注入：`GITNEXUS_NEO4J_URI`、`GITNEXUS_NEO4J_USER`、`GITNEXUS_NEO4J_PASSWORD`、`GITNEXUS_STORAGE_BACKEND=neo4j`。

## 风险

- 这是核心存储替换，不是小范围性能优化；影响 CLI、MCP、Web API、group bridge、测试夹具和部署。
- LadybugDB Cypher 与 Neo4j Cypher 并非完全一致，需要逐条迁移查询。
- Neo4j vector index 创建后需要等待 `ONLINE`，否则首轮查询可能为空。
- `cypher` 工具从本地单文件变为远程数据库连接，错误信息和权限边界会变化。
- 旧 `.gitnexus/lbug` 文件不能自动无损迁移；建议重新 `gitnexus analyze --embeddings` 重建索引。

## 验收

- `docker compose -f mcp_proxy_docker/docker-compose.yml config` 通过。
- `docker pull neo4j:2026.04.0` 通过。
- `gitnexus` TypeScript 编译通过。
- 新增 Neo4j adapter 单元测试通过。
- `query` 可返回 Neo4j vector 命中。
- `context` 可返回 Neo4j 图关系。
- `impact` 可完成至少一层上游/下游遍历。
- group query 可跨多个 `repoId` 返回合并结果。
