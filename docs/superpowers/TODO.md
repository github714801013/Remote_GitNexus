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
