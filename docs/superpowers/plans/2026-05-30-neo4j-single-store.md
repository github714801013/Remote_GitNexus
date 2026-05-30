# Neo4j Single Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 GitNexus 的 LadybugDB 单文件索引替换为 Neo4j 服务化图 + 向量单库。

**Architecture:** 新增 Neo4j 存储适配层，先以兼容接口承接 LadybugDB adapter 的查询、写入、向量检索和生命周期方法，再逐步把 MCP/CLI/Web API 调用点切换到 backend abstraction。Neo4j 通过 `repoId` 做多仓库隔离，通过原生 relationship 和 vector index 支持图遍历与语义检索。

**Tech Stack:** Node.js 20+、TypeScript、neo4j-driver、Neo4j Community Docker image、Neo4j vector index、Vitest、Docker Compose。

---

### Task 1: Neo4j 配置和依赖

**Files:**
- Modify: `gitnexus/package.json`
- Modify: `mcp_proxy_docker/docker-compose.yml`
- Create: `gitnexus/src/core/neo4j/config.ts`
- Test: `gitnexus/test/unit/neo4j-config.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `gitnexus/test/unit/neo4j-config.test.ts`，覆盖默认配置、显式环境变量、非法 URI、缺失密码。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd gitnexus; npm test -- test/unit/neo4j-config.test.ts`

Expected: FAIL，提示找不到 `src/core/neo4j/config.ts`。

- [ ] **Step 3: 实现配置读取**

新增 `loadNeo4jConfig()`，读取 `GITNEXUS_STORAGE_BACKEND`、`GITNEXUS_NEO4J_URI`、`GITNEXUS_NEO4J_USER`、`GITNEXUS_NEO4J_PASSWORD`、`GITNEXUS_NEO4J_DATABASE`、`GITNEXUS_EMBEDDING_DIMS`。

- [ ] **Step 4: 增加依赖和 compose**

添加 `neo4j-driver` 依赖。compose 中移除 `pgvector`，新增 `neo4j` 服务和 `gitnexus-mcp-proxy` 环境变量。

- [ ] **Step 5: 验证**

Run:

```powershell
cd gitnexus; npm test -- test/unit/neo4j-config.test.ts
docker compose -f ../mcp_proxy_docker/docker-compose.yml config
docker pull neo4j:2026.04.0
```

Expected: 全部通过。

### Task 2: Neo4j driver 生命周期

**Files:**
- Create: `gitnexus/src/core/neo4j/driver.ts`
- Test: `gitnexus/test/unit/neo4j-driver.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖同一配置复用 driver、`closeNeo4j()` 幂等、查询 session 使用 configured database。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd gitnexus; npm test -- test/unit/neo4j-driver.test.ts`

Expected: FAIL，提示模块不存在。

- [ ] **Step 3: 实现 driver lifecycle**

实现 `getNeo4jDriver()`、`withNeo4jSession()`、`closeNeo4j()`，所有查询必须参数化。

- [ ] **Step 4: 验证**

Run: `cd gitnexus; npm test -- test/unit/neo4j-driver.test.ts`

Expected: PASS。

### Task 3: Neo4j schema 初始化

**Files:**
- Create: `gitnexus/src/core/neo4j/schema.ts`
- Test: `gitnexus/test/unit/neo4j-schema.test.ts`

- [ ] **Step 1: 写失败测试**

断言 schema 初始化会生成 repoId/id 唯一约束、CodeEmbedding vector index、常用 file/name 索引。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd gitnexus; npm test -- test/unit/neo4j-schema.test.ts`

Expected: FAIL，提示模块不存在。

- [ ] **Step 3: 实现 schema statements**

基于 `NODE_TABLES` 和 `EMBEDDING_DIMS` 生成 Neo4j `CREATE CONSTRAINT`、`CREATE INDEX`、`CREATE VECTOR INDEX` 语句。

- [ ] **Step 4: 验证**

Run: `cd gitnexus; npm test -- test/unit/neo4j-schema.test.ts`

Expected: PASS。

### Task 4: 节点和关系批量写入

**Files:**
- Create: `gitnexus/src/core/neo4j/write-adapter.ts`
- Modify: `gitnexus/src/core/run-analyze.ts`
- Test: `gitnexus/test/unit/neo4j-write-adapter.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖按 `repoId` 删除旧索引、批量 upsert 节点、批量 upsert 关系、关系 type 白名单校验。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd gitnexus; npm test -- test/unit/neo4j-write-adapter.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现写入 adapter**

提供 `clearRepoIndex(repoId)`、`upsertNodes(repoId, nodes)`、`upsertRelations(repoId, relations)`。

- [ ] **Step 4: 接入 analyze**

在 `GITNEXUS_STORAGE_BACKEND=neo4j` 时走 Neo4j 写入，否则保留当前 LadybugDB 路径，直到最终切换完成。

- [ ] **Step 5: 验证**

Run: `cd gitnexus; npm test -- test/unit/neo4j-write-adapter.test.ts`

Expected: PASS。

### Task 5: embedding 写入和向量检索

**Files:**
- Create: `gitnexus/src/core/neo4j/embedding-adapter.ts`
- Modify: `gitnexus/src/core/embeddings/embedding-pipeline.ts`
- Modify: `gitnexus/src/mcp/local/local-backend.ts`
- Test: `gitnexus/test/unit/neo4j-embedding-adapter.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖 chunk upsert、contentHash 增量判断、vector query 结果按 score 排序、返回 `nodeId/filePath/startLine/endLine`。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd gitnexus; npm test -- test/unit/neo4j-embedding-adapter.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现 embedding adapter**

提供 `fetchExistingEmbeddingHashes(repoId)`、`upsertEmbeddings(repoId, updates)`、`semanticSearch(repoId, queryVector, limit)`。

- [ ] **Step 4: 接入 semanticSearch**

`LocalBackend.semanticSearch()` 在 Neo4j backend 下查询 Neo4j vector index，保留 RRF 合并逻辑。

- [ ] **Step 5: 验证**

Run: `cd gitnexus; npm test -- test/unit/neo4j-embedding-adapter.test.ts`

Expected: PASS。

### Task 6: 图查询、context 和 impact

**Files:**
- Create: `gitnexus/src/core/neo4j/read-adapter.ts`
- Modify: `gitnexus/src/mcp/local/local-backend.ts`
- Test: `gitnexus/test/unit/neo4j-read-adapter.test.ts`
- Test: `gitnexus/test/unit/neo4j-impact-adapter.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖只读 Cypher 拦截、按符号名查上下文、一层 impact、递归 impact 深度限制。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd gitnexus; npm test -- test/unit/neo4j-read-adapter.test.ts test/unit/neo4j-impact-adapter.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现 read adapter**

提供 `executeReadCypher()`、`findSymbolContext()`、`findImpact()`。

- [ ] **Step 4: 接入 LocalBackend**

将 `context`、`impact`、`cypher` 的 Neo4j backend 分支接入 read adapter。

- [ ] **Step 5: 验证**

Run: `cd gitnexus; npm test -- test/unit/neo4j-read-adapter.test.ts test/unit/neo4j-impact-adapter.test.ts`

Expected: PASS。

### Task 7: 跨仓库搜索

**Files:**
- Modify: `gitnexus/src/mcp/local/local-backend.ts`
- Test: `gitnexus/test/unit/neo4j-cross-repo-query.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖 group query 传入多个 `repoId` 时 Neo4j 单次 vector query 返回跨仓库结果，并保持 RRF 排序。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd gitnexus; npm test -- test/unit/neo4j-cross-repo-query.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现跨仓库查询**

将 Neo4j backend 下的 vector discovery 从 per-repo fan-out 改为 `repoId IN $repoIds` 过滤。

- [ ] **Step 4: 验证**

Run: `cd gitnexus; npm test -- test/unit/neo4j-cross-repo-query.test.ts`

Expected: PASS。

### Task 8: 集成验证和部署脚本

**Files:**
- Modify: `mcp_proxy_docker/remote_deploy.sh`
- Modify: `mcp_proxy_docker/app/executor.py`
- Test: `mcp_proxy_docker/tests/test_executor.py`

- [ ] **Step 1: 写或更新失败测试**

覆盖部署环境中 Neo4j env 透传，确保不再引用 pgvector。

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest mcp_proxy_docker/tests/test_executor.py`

Expected: FAIL，旧测试仍期待 pgvector 或缺少 Neo4j env。

- [ ] **Step 3: 更新部署脚本**

用 Git Bash 执行路径兼容的 shell 脚本，确保远端 compose 启动 Neo4j 并向 GitNexus 注入连接变量。

- [ ] **Step 4: 验证**

Run:

```powershell
python -m pytest mcp_proxy_docker/tests/test_executor.py
bash -n mcp_proxy_docker/remote_deploy.sh
git diff --check
cd gitnexus; npx tsc --noEmit
```

Expected: 全部通过。

### Task 9: 端到端 smoke

**Files:**
- No new production files unless earlier tasks reveal gaps.

- [ ] **Step 1: 本地启动 Neo4j**

Run: `docker compose -f mcp_proxy_docker/docker-compose.yml up -d neo4j`

Expected: Neo4j healthcheck 通过。

- [ ] **Step 2: analyze 重建索引**

Run: `cd gitnexus; $env:GITNEXUS_STORAGE_BACKEND='neo4j'; npm run build`

Expected: build 通过。若本地 Neo4j 可用，再执行小型 fixture analyze。

- [ ] **Step 3: MCP 查询验证**

验证 `query`、`context`、`impact`、group query 至少各一条成功输出。

- [ ] **Step 4: 精确暂存**

Run: `git add <本次修改文件清单>`，严禁 `git add .`。

- [ ] **Step 5: 暂存区核对**

Run: `git diff --cached --name-only`

Expected: 只包含本次 Neo4j 迁移相关文件。
