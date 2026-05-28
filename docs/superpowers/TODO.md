# Dev-Spec-Gen 本地工程规范达成看板

## Phase 1: Research & Setup (初始化)
- [x] 运行环境与版本确认 (Runtime/Environment Check)：混合仓库，本次范围为 gitnexus Node/TypeScript 服务端；证据：package.json、gitnexus/package.json、gitnexus/src/server。
- [x] 租户隔离/路径前缀确认 (Tenant/Path Context)：不涉及业务租户；涉及远程 webhook 仓库路径锁。
- [x] 核心规范检索 (qmd Discovery)：已读取 dev-spec-gen references/general-specs.md；GitNexus MCP 无本仓库索引，降级本地检索。
- [x] 涉及技能识别：dev-spec-gen；不适用 Java/Spring AiAutoTestController。

## Phase 2: Design (文档先行)
- [x] API-First: 接口文档定义 (API Spec)：不改 HTTP 契约；只调整 webhook 后台 analyze 队列对仓库锁冲突的处理。
- [x] DB-First: 数据库变更脚本编写 (SQL/Schema Migration)：不涉及数据库。
- [x] 性能优化要点：批量/IN/循环查库/缓存/SQL/前端性能覆盖或不适用说明：不涉及。
- [x] 编码规范要点：Java/SQL/DTO/Mapper/热部署/引用规范覆盖或不适用说明：Node/TypeScript，Java 专用规则不适用。
- [x] 测试要点：补充单测覆盖仓库锁冲突识别、巡检 stale 触发增量 analyze；运行定向 vitest 与 tsc。

## Phase 3: Implementation (开发)
- [x] 业务逻辑实现 (Surgical Change)：仓库锁冲突降级为 webhook analyze skipped；巡检 stale index 时排队 force:false 增量 analyze。
- [x] 规范合规注释注入 (Spec Compliance Comments)：本次逻辑直观，无新增注释。

## Phase 4: Verification (验证)
- [x] Bug Reproduction (针对 Bug 修复)：新增单测先失败，错误为 isRepoAlreadyActiveError is not a function。
- [x] 项目构建/编译通过 (Build/Compilation Passed)：npx tsc --noEmit 通过。
- [x] 单入口/集成测试验证 (Single-Entry/Integration Test)：npm test -- test/unit/analyze-api.test.ts test/unit/webhook-analyze-queue.test.ts test/unit/webhook-worktree.test.ts 通过，20 tests。
- [x] 接口一致性比对 (Response Schema Check)：不改 HTTP 响应字段。

## Phase 5: Audit & Finish (审计与完结)
- [x] 本地工程合规审计表输出 (Compliance Audit Report)：红队指出锁外 clone/reset 风险，已修复。
- [x] 完结审计拦截 (Final Phase Check)：用户已要求提交并部署；提交前核对暂存区。

## Current Diagnostic: Cross-Repo Vector Discovery
- [x] 运行环境确认：线上容器 `gitnexus-mcp-proxy` 健康，错误路径为容器内 `/projects/.../.gitnexus/lbug`。
- [x] Bug Reproduction：跨仓库查询日志复现 `query:vector-discovery:<repo>` LadybugDB mmap/integrity 错误。
- [x] 向量化状态核对：容器内 `meta.json` 显示 `oa-pc`、`oa-order`、`jiuji-mp` 等仓库 `stats.embeddings` 均大于 0。
- [x] 单仓库向量检索核对：指定 `repo=oa-pc`、`repo=oa-order`、`repo=jiuji-mp` 查询均出现 vector 阶段并返回结果。
- [x] 后续修复：限制跨仓库 vector discovery 的 LadybugDB 并发打开数量，默认并发 4，可通过 `GITNEXUS_CROSS_REPO_VECTOR_CONCURRENCY` 调整。
- [x] 后续修复：并发跨仓库查询按 `repo.id` 串行错峰，同一项目的 discovery/query 不重叠，不同项目保持并发。
- [x] 回归验证：`npx vitest run test/unit/zoekt-query-integration.test.ts` 通过，8 tests。
- [x] 回归验证：`npx vitest run test/unit/zoekt-query-integration.test.ts test/unit/calltool-dispatch.test.ts test/unit/mcp-filtering.test.ts` 通过，87 tests。
- [x] 编译验证：`npx tsc --noEmit` 通过。
- [x] 回归验证：新增同项目错峰用例后，`npx vitest run test/unit/zoekt-query-integration.test.ts` 通过，9 tests。
- [x] 回归验证：新增同项目错峰用例后，`npx vitest run test/unit/zoekt-query-integration.test.ts test/unit/calltool-dispatch.test.ts test/unit/mcp-filtering.test.ts` 通过，88 tests。
- [x] Bug Reproduction：`备用机 押金支付 支持哪些支付方式逻辑` 不指定 repo 时 discovery 包含 `oa-pc`，但最终 `matches/matched_repos` 被截断丢失。
- [x] 后续修复：跨仓库 `matches` 截断先保留每个项目的最高分代表命中，再填充剩余高分详情，避免 `oa-pc` 这类候选仓库被挤出。
- [x] 回归验证：新增 matches 截断覆盖用例后，`npx vitest run test/unit/zoekt-query-integration.test.ts` 通过，10 tests。
- [x] 回归验证：新增 matches 截断覆盖用例后，`npx vitest run test/unit/zoekt-query-integration.test.ts test/unit/calltool-dispatch.test.ts test/unit/mcp-filtering.test.ts` 通过，89 tests。
