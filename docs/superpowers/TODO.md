# Dev-Spec-Gen 本地工程规范达成看板

## Phase 1: Research & Setup (初始化)
- [x] 运行环境与版本确认 (Runtime/Environment Check): 当前为 Node/TypeScript monorepo，主改动范围在 `gitnexus/` 和 `mcp_proxy_docker/`。
- [x] 租户隔离/路径前缀确认 (Tenant/Path Context): 本需求为 GitNexus 存储后端迁移，不涉及业务租户隔离。
- [x] 核心规范检索 (qmd Discovery): 已加载 `dev-spec-gen`、`general-specs.md`、`backend-dev-specs.md`、superpowers brainstorming/writing-plans/TDD/executing-plans；qmd 对 pgvector/Neo4j 专项规范无命中。
- [x] 涉及技能识别：`dev-spec-gen`、`superpowers:brainstorming`、`superpowers:writing-plans`、`superpowers:test-driven-development`、`superpowers:executing-plans`。

## Phase 2: Design (文档先行)
- [x] API-First: 本次保持 MCP/CLI/Web API 参数和返回契约不变，先不新增对外 API 文档。
- [x] DB-First: 已新增 Neo4j 单库替代设计，见 `docs/superpowers/specs/2026-05-30-neo4j-single-store-design.md`。
- [x] 性能优化要点：使用 Neo4j 服务化连接、事务批处理、`repoId` 过滤、vector index、跨仓库单次查询替代 per-repo fan-out。
- [x] 编码规范要点：Node/TypeScript 项目，不适用 Java/Spring/AiAutoTestController；源码实现前必须按 TDD 先写失败测试。
- [x] 测试要点：计划已覆盖配置、driver、schema、写入、embedding、read/context/impact、跨仓库、部署和 smoke 验证。

## Phase 3: Implementation (开发)
- [x] 业务逻辑实现 (Surgical Change): 已完成 Neo4j config/driver/schema/write/embedding/read adapter、run analyze 图与 embedding 写入、LocalBackend Neo4j semantic search/cypher/context/impact 分支和跨仓库单次 vector discovery；默认 LadybugDB 路径保持不变。
- [x] 规范合规注释注入 (Spec Compliance Comments): compose 中已标明 Neo4j 单库图及向量索引存储用途。

## Phase 4: Verification (验证)
- [ ] Bug Reproduction (针对 Bug 修复)
- [x] 项目构建/编译通过 (Build/Compilation Passed): `cd gitnexus; npx tsc --noEmit` 通过。
- [x] 单入口/集成测试验证 (Single-Entry/Integration Test): Neo4j 新增/改动相关 13 个 unit 测试文件共 60 个测试通过；`cd gitnexus; npx tsc --noEmit` 通过；`docker compose -f mcp_proxy_docker/docker-compose.yml config` 通过；`docker pull neo4j:2026.04.0` 成功。
- [x] 接口一致性比对 (Response Schema Check): 已执行 `mcp_proxy_docker/remote_deploy.sh`，远端 `auto_verify.py` 返回服务 API 就绪并列出索引快照；远端 `GITNEXUS_STORAGE_BACKEND=neo4j`，`code_embedding_idx` 为 `VECTOR/ONLINE`；`MyDjangoProject` 实测 4802 个 Neo4j 节点、2196 条向量。远端 CLI 实测 `context`、`impact`、单仓库 `query` 和无 `-r` 跨仓库 `query` 均可返回结果，`query` timing 中包含 `vector` 阶段，跨仓库结果覆盖 19 个仓库且不再返回 LadybugDB 错误。已修复 Neo4j 空库早返回、`LIMIT` 参数类型、repoId 注册名不一致、Neo4j 模式下 query 误初始化/读取 LadybugDB 的问题。

## Phase 5: Audit & Finish (审计与完结)
- [x] 本地工程合规审计表输出 (Compliance Audit Report): 本次交付限定为 Neo4j 单库存储、查询分支、embedding 写入、compose 部署和对应测试；部署脚本已跳过 LadybugDB 索引 `meta.json` 备份；废弃 pgvector 文档未纳入暂存。
- [x] 完结审计拦截 (Final Phase Check): 已执行精确暂存并核对 `git diff --cached --name-only`。

## Patch: Neo4j 跨库查询与 LadybugDB 初始化熔断
- [x] MCP 描述更新：Neo4j 下优先省略 `repo` 做跨库查询，拿到具体项目后再指定 `repo` 缩小范围；LadybugDB 单文件库不做真正跨库图/向量查询。
- [x] 查询路径更新：Neo4j repo-less `query` 直接返回跨库 discovery 结果，不再按候选 repo 循环调用单仓库 `query`。
- [x] 初始化熔断：Neo4j 后端下 `ensureInitialized()` 直接返回，不初始化 LadybugDB 文件库。
- [x] 验证：`npm test -- test/unit/neo4j-cross-repo-query.test.ts test/unit/tools.test.ts`、`npx tsc --noEmit`、`git diff --check` 通过。

## Patch: Neo4j CodeNode 端点索引与关系事务拆批
- [x] 技能激活幂等检查：已读取 `dev-spec-gen`、`using-superpowers`、`writing-plans`、`systematic-debugging`、`test-driven-development`、`verification-before-completion`。
- [x] 技术栈识别：`gitnexus/package.json`、`gitnexus/tsconfig.json`、`gitnexus/vitest.config.ts` 证明本次范围为 TypeScript/Node/Vitest。
- [x] qmd Discovery：已初始化 qmd；关键词检索无命中，改用 `dev-spec-gen/references/*.md` 物理路径证据。
- [x] 工作区审计：当前分支 `xiexiongkun/feat-pgvector-pg18-cross-repo-search`；既有未跟踪 payload/stackdump/旧 plan/spec 不纳入本次暂存。
- [x] 计划文件：`docs/superpowers/plans/2026-05-31-neo4j-codenode-batching.md`。
- [x] Bug Reproduction：红灯测试已验证当前缺少 `CodeNode` 约束、端点 label 匹配和事务拆批。
- [x] 实现：`schema.ts` 增加共享 `CodeNode` 约束；`write-adapter.ts` 为代码节点增加共享 `CodeNode` 标签、用 `CodeNode` 匹配关系端点，并将关系写入拆成 500 条一批的事务。
- [x] 验证：`npm test -- test/unit/neo4j-schema.test.ts test/unit/neo4j-write-adapter.test.ts` 通过，11 tests。
- [x] 验证：`npm test -- analyze-api.test.ts test/unit/neo4j-schema.test.ts test/unit/neo4j-write-adapter.test.ts` 通过，22 tests。
- [x] 验证：`npx tsc --noEmit` 通过。
- [x] 验证：目标文件 `git diff --check` 通过。
- [x] Red：新增 `clearRepoIndex` 删除拆批测试，验证旧版 label-free `MATCH (n {repoId}) DETACH DELETE n` 会失败。
- [x] 实现：`clearRepoIndex` 按 `CodeNode` 与 `CodeEmbedding` label 分批删除，每批 500，避免删除阶段长事务和 label-free 扫描。
- [x] 远端清理：终止 10 条 12 小时以上旧版 Neo4j 关系写入事务，复查仅剩当前 `SHOW TRANSACTIONS` 毫秒级事务。
- [x] 远端二次清理：旧服务又产生 3 条 8-9 分钟旧版关系写入事务，已终止并杀掉 3 个旧版 `analyze-worker.js` 子进程。
- [x] 部署尝试：`remote_deploy.sh` 本地 Docker build 成功生成镜像 `8c3acca...`，但 `docker save` / `docker save -o` 在本机卡住，完整镜像传输部署未完成。
- [x] 热补上线：复制 `write-adapter.js`、`schema.js`、`api.js` 和 `dist/_shared` 到远端 `gitnexus-mcp-proxy` 容器并重启；`/health` 返回 ok。
- [x] 远端复查：Neo4j `SHOW TRANSACTIONS` 只剩当前查询自身的毫秒级事务，未见旧版 label-free 写入事务。
- [x] 复跑回归测试、类型检查和 staged diff 检查。
- [x] 精确暂存本次文件并执行 `git diff --cached --name-only` 审计。

## Patch: oa-stock Gitea webhook 分支索引
- [x] 技术栈识别：`gitnexus/package.json`、`gitnexus/tsconfig.json`、`gitnexus/vitest.config.ts` 证明本次范围为 TypeScript/Node/Vitest。
- [x] 影响分析：GitNexus MCP 未索引 GitNexus 本仓库，无法运行图影响分析；已用本地引用检索确认触达 `api.ts` 与 `webhook-worktree.ts`。
- [x] Bug Reproduction：现场证据为 `/webhook/gitea` payload 分支 `release_9ji`，但 list_repos 中 `oa-stock` 仍显示 `dev` 且 stale；代码证据为 webhook analyze 入队未传 `registryName` / `registryBranch`。
- [x] 计划文件：`docs/superpowers/plans/2026-05-31-oa-stock-webhook-branch.md`。
- [x] 实现：Gitea webhook 与 startup repos.json 调度 analyze 时传递 `registryName` 与 `registryBranch`。
- [x] 实现：analyze 早返回逻辑比较 `registryBranch` 与旧 meta 分支，分支变化时重新落库 meta/registry。
- [x] 实现：启动巡检从 `repos.json` 读取目标分支覆盖旧 registry 分支；同仓库 deferred webhook 优先于其它待处理仓库执行。
- [x] 实现：webhook 队列任务在 `finally` 释放 repo lock，避免同仓库 deferred 任务被误判 active 后跳过。
- [x] 实现：worker 完成后由父进程兜底写入 meta/registry，确保 HTTP/MCP 清单使用当前工作树分支和 commit。
- [x] 验证：`npm test -- test/unit/webhook-worktree.test.ts test/unit/analyze-api.test.ts test/unit/run-analyze.test.ts test/unit/webhook-analyze-queue.test.ts`、`npx tsc --noEmit`、`git diff --check` 通过。
- [x] 部署验证：使用 `mcp_proxy_docker/remote_deploy.sh` 重新部署后触发 oa-stock webhook；meta、registry、HTTP `/api/repos`、MCP `list_repos` 均显示 `oa-stock` 分支为 `release_9ji`。
